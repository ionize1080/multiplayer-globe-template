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
