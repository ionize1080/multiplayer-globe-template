import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validRadarFrames} from '../src/client/use-radar';
import {fieldColor} from '../src/client/weather-palettes';
import {cityWeather} from '../src/server/weather-cities';
import {weatherCities} from '../src/weather-cities';
import {Miniflare} from 'miniflare';
import {readFileSync} from 'node:fs';
test('radar accepts current hashed frame paths and rejects untrusted URLs',()=>{
 const frames=validRadarFrames({radar:{past:[{time:2,path:'/v2/radar/1b97dac9d456'},{time:1,path:'/v2/radar/1793706600'},{time:3,path:'https://invalid.example/x'},{time:4,path:'/v2/radar/../../x'}]}});
 assert.deepEqual(frames.map(f=>f.time),[1,2]);
 assert.deepEqual(validRadarFrames({}),[]);
});
test('scales clamp at physical display endpoints and distinguish freezing from warm weather',()=>{
 assert.deepEqual(fieldColor(-100,'temperature'),fieldColor(-40,'temperature'));
 assert.deepEqual(fieldColor(200,'humidity'),fieldColor(100,'humidity'));
 assert.notDeepEqual(fieldColor(0,'temperature'),fieldColor(30,'temperature'));
 assert.notDeepEqual(fieldColor(990,'pressure'),fieldColor(1030,'pressure'));
});
test('city requests are batched and cached across visitors; missing data is never zero degrees',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2025-04-01',d1Databases:['DB']});const original=globalThis.fetch;let calls=0;
 try{const db=await mf.getD1Database('DB');for(const sql of readFileSync('migrations/0001_weather_cache.sql','utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();globalThis.fetch=async(input)=>{calls++;const u=new URL(String(input));assert.equal(u.searchParams.get('latitude')!.split(',').length,weatherCities.length);return Response.json(weatherCities.map((_,i)=>({current:{time:'2026-11-03T12:00',temperature_2m:i?15:null}})));};const d=await (await cityWeather(db)).json();assert.equal(d.cities[0].temperature,null);assert.equal(d.cities[1].temperature,15);assert.equal(d.cities[1].time,'2026-11-03T12:00Z');await cityWeather(db);assert.equal(calls,1);}finally{globalThis.fetch=original;await mf.dispose();}
});
import {parseCoordinates,normalizeQuery,photonResults} from '../src/place-search';
import {searchPlaces} from '../src/server/place-search';
test('coordinate search supports decimal, Chinese comma, cardinal direction and DMS',()=>{
 for(const input of ['25.04, 102.71','25.04，102.71','25.04N 102.71E','E102.71 N25.04',`25°2'24"N, 102°42'36"E`]){const p=parseCoordinates(input);assert.ok(p,input);assert.ok(Math.abs(p.lat-25.04)<1e-7,input);assert.ok(Math.abs(p.lon-102.71)<1e-7,input);}
 assert.deepEqual(parseCoordinates('33.86S 151.21E'),{lat:-33.86,lon:151.21});
 for(const input of ['91, 100','25,181','25N 26N','25°70\'N,102E','昆明','some25N 102E'])assert.equal(parseCoordinates(input),null,input);
 assert.equal(normalizeQuery('  New   YORK '),'new york');
});
test('place results reject invalid coordinates, deduplicate OSM IDs and preserve fine addresses',()=>{
 const f={geometry:{coordinates:[102.7,25]},properties:{osm_type:'N',osm_id:1,name:'昆明站',street:'北京路',city:'昆明市',country:'中国',type:'house'}};
 const r=photonResults({features:[f,f,{geometry:{coordinates:[200,100]}}]});assert.equal(r.length,1);assert.equal(r[0].name,'昆明站');assert.match(r[0].detail,/北京路/);
});
test('search caches normalized multilingual queries across users with a separate quota',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2025-04-01',d1Databases:['DB']});const original=globalThis.fetch;let calls=0;
 try{const db=await mf.getD1Database('DB');for(const sql of readFileSync('migrations/0001_weather_cache.sql','utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();globalThis.fetch=async(input)=>{calls++;const u=new URL(String(input));assert.equal(u.hostname,'photon.komoot.io');return Response.json({features:[{geometry:{coordinates:[102.7,25]},properties:{name:'昆明',osm_id:1,osm_type:'R'}}]});};for(const q of [' Kunming ','kunming']){const r=await searchPlaces(new Request('https://ionize.club/api/globe/search?q='+encodeURIComponent(q)),db,q);assert.equal(r.status,200);}assert.equal(calls,1);const coordinate=await searchPlaces(new Request('https://ionize.club/api/globe/search?q=25,102'),db,'c');assert.equal(coordinate.status,200);assert.equal(calls,1);const usage=await db.prepare("SELECT bucket FROM globe_weather_usage WHERE bucket LIKE 'global-%'").all();assert.equal(usage.results.length,0);}finally{globalThis.fetch=original;await mf.dispose();}
});
import {naturalPlace} from '../src/place-search';
test('polar and ocean names resolve to natural features in Chinese and English, not same-named streets',()=>{
 assert.deepEqual(naturalPlace('北冰洋'),naturalPlace('Arctic Ocean'));
 assert.equal(naturalPlace('Southern Ocean')?.kind,'ocean');
 assert.equal(naturalPlace('South Pole')?.lat,-90);
 assert.equal(naturalPlace('北极')?.lat,90);
 assert.equal(naturalPlace('Pacific Ocean')?.lon,-150);
 assert.equal(naturalPlace('Arctic Ocean Drive'),null);
});
