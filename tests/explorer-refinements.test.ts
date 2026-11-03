import {test} from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
import {cityReferenceKeys,mergeCityPlaces} from '../src/city-visibility';
import {searchQueries,mergeSearchResults} from '../src/place-search';
import {terrainViewPlan,terrainPosition} from '../src/terrain';
import {TerrainDiskCache} from '../src/client/terrain-cache';
test('zoomed city catalogues add regional cities and handle the dateline without unbounded downloads',()=>{
 assert.deepEqual(cityReferenceKeys({west:-180,east:180,south:-90,north:90}),[]);
 const keys=cityReferenceKeys({west:100,east:120,south:20,north:40});assert.ok(keys.length>0&&keys.length<=6);
 const rows=keys.flatMap(k=>{try{return JSON.parse(readFileSync(`public/data/reference/${k}.places.json`,'utf8'));}catch{return [];}});
 assert.ok(mergeCityPlaces([],rows).length>80);
 const wrap=cityReferenceKeys({west:175,east:-175,south:-10,north:10});assert.ok(wrap.some(k=>k.startsWith('17-'))&&wrap.some(k=>k.startsWith('0-')));
 const p={name:'同名',lat:25,lon:102,rank:1};assert.equal(mergeCityPlaces([p],[p,{...p,lat:26},{...p,kind:'province'}]).length,2);
});
test('Chinese overseas queries search English aliases first but retain original-language candidates',()=>{
 assert.deepEqual(searchQueries('华盛顿'),['Washington','华盛顿']);assert.deepEqual(searchQueries('华盛顿州'),['Washington','华盛顿州']);assert.deepEqual(searchQueries('北京'),['北京']);
 const p={id:'us',name:'Washington',detail:'United States',lat:38.9,lon:-77,kind:'city'};assert.deepEqual(mergeSearchResults([[p],[p,{...p,id:'cn',detail:'China'}]]).map(p=>p.id),['us','cn']);
});
test('terrain starts at visible high detail with at most four initial tiles',()=>{
 const p=terrainViewPlan({west:102.5,east:102.9,south:24.8,north:25.2});assert.ok(p.minimumLevel>=8);const nw=terrainPosition(p.north-1e-8,p.west+1e-8,p.minimumLevel)!,se=terrainPosition(p.south+1e-8,p.east-1e-8,p.minimumLevel)!;assert.ok((Math.floor(se.x)-Math.floor(nw.x)+1)*(Math.floor(se.y)-Math.floor(nw.y)+1)<=4);
 for(const bounds of [{west:0,east:10,south:86,north:90},{west:0,east:10,south:-90,north:-86}])assert.equal(terrainViewPlan(bounds).minimumLevel,0);
 assert.ok(p.west<=102.5&&p.east>=102.9&&p.south<=24.8&&p.north>=25.2);assert.equal(terrainViewPlan({west:170,east:-170,south:-20,north:20}).minimumLevel,0);
});
test('terrain disk cache is reusable, bounded and tolerant of unavailable storage',async()=>{
 const original=globalThis.caches;const entries=new Map<string,Response>();let opened='';
 const fake={match:async(k:string)=>entries.get(k)?.clone(),put:async(k:string,v:Response)=>{entries.delete(k);entries.set(k,v);},delete:async(k:string)=>entries.delete(k),keys:async()=>[...entries.keys()]};
 Object.defineProperty(globalThis,'caches',{configurable:true,value:{open:async(name:string)=>{opened=name;return fake;}}});
 try{const c=new TerrainDiskCache();await c.put('/tile',new Blob(['png']));assert.match(opened,/terrain/);assert.equal(await (await new TerrainDiskCache().get('/tile'))?.text(),'png');entries.set('/old',new Response('old',{headers:{'X-Terrain-Cached-At':'1'}}));assert.equal(await c.get('/old'),null);for(let i=0;i<280;i++)await c.put('/'+i,new Blob(['png']));assert.ok(entries.size<=271);Object.defineProperty(globalThis,'caches',{configurable:true,value:{open:async()=>{throw Error('quota');}}});assert.equal(await new TerrainDiskCache().get('/tile'),null);}finally{Object.defineProperty(globalThis,'caches',{configurable:true,value:original});}
});

import{clarifyWashington}from'../src/place-search';
test('Washington distinguishes and ranks the US capital and state',()=>{const p={id:'state',name:'Washington',detail:'United States',lat:47.28,lon:-120.21,kind:'state'},c={...p,id:'capital',lat:38.8951,lon:-77.0364,kind:'city'};assert.equal(clarifyWashington([p,c],'华盛顿')[0].id,'capital');assert.equal(clarifyWashington([p,c],'华盛顿州')[0].id,'state');assert.match(clarifyWashington([p,c],'华盛顿')[0].name,/特区/);});

import {cityDisplayPolicy} from '../src/city-visibility';
import {locationDetails} from '../src/location-details';
import {pointLocation} from '../src/server/location-details';
import {Miniflare} from 'miniflare';
test('density modes expose progressively more places at the same scale',()=>{for(const height of [50000,1000000,3000000,10000000]){const a=cityDisplayPolicy('major',height),b=cityDisplayPolicy('standard',height),c=cityDisplayPolicy('detailed',height);assert.ok(a.maxRank<=b.maxRank&&b.maxRank<=c.maxRank);assert.ok(a.gapX>b.gapX&&b.gapX>c.gapX);}});
test('location hierarchy preserves fine address fields and rejects distant or malformed matches',()=>{const feature={geometry:{coordinates:[103.8545,1.2868]},properties:{country:'Singapore',countrycode:'SG',state:'Central',city:'Singapore',district:'Downtown Core',street:'Fullerton Promenade',housenumber:'1',name:'Merlion Fountain',postcode:'049215'}};const result=locationDetails({features:[feature]},1.2868,103.8545);assert.equal(result.parts[0].value,'新加坡');assert.equal(result.distanceMeters,0);assert.deepEqual(result.parts.slice(-3).map(p=>p.label),['门牌','具体地点','邮编']);assert.equal(locationDetails({features:[feature]},85,0).parts.length,0);assert.equal(locationDetails({features:[null,{}]},0,0).parts.length,0);});
test('location endpoint validates coordinates and shares a precise cache across users',async()=>{const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2025-04-01',d1Databases:['DB']});const original=globalThis.fetch;let calls=0;try{const db=await mf.getD1Database('DB');for(const sql of readFileSync('migrations/0001_weather_cache.sql','utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();globalThis.fetch=async(input)=>{calls++;const u=new URL(String(input));assert.equal(u.hostname,'photon.komoot.io');assert.equal(u.pathname,'/reverse');assert.equal(u.searchParams.get('radius'),'1');return Response.json({features:[{geometry:{coordinates:[103.8545,1.2868]},properties:{name:'Merlion',country:'Singapore',countrycode:'SG'}}]});};for(const user of ['a','b']){const r=await pointLocation(new Request('https://ionize.club/api/globe/location?lat=1.2868&lon=103.8545'),db,user);assert.equal(r.status,200);assert.equal((await r.json()).parts[0].value,'新加坡');}assert.equal(calls,1);assert.equal((await pointLocation(new Request('https://ionize.club/api/globe/location?lat=91&lon=0'),db,'c')).status,400);assert.equal(calls,1);}finally{globalThis.fetch=original;await mf.dispose();}});

import * as Cesium from 'cesium';
import {visibleRectangle} from '../src/client/visible-rectangle';
test('2D viewport uses actual map corners even when the spherical horizon has no bounds',()=>{const viewer={scene:{mode:Cesium.SceneMode.SCENE2D,canvas:{clientWidth:800,clientHeight:600},globe:{ellipsoid:Cesium.Ellipsoid.WGS84}},camera:{positionCartographic:{height:30000},computeViewRectangle(){throw Error('Spherical bounds must not be used in 2D');},pickEllipsoid(p:{x:number;y:number}){return Cesium.Cartesian3.fromDegrees(p.x<400?179:-179,p.y<300?20:19);}}};const r=visibleRectangle(viewer as never,Cesium)!;assert.ok(Math.abs(Cesium.Math.toDegrees(r.west)-179)<1e-6);assert.ok(Math.abs(Cesium.Math.toDegrees(r.east)+179)<1e-6);assert.ok(Math.abs(Cesium.Math.toDegrees(r.north)-20)<1e-6);assert.ok(cityReferenceKeys({west:179,east:-179,south:19,north:20}).length>0);});
