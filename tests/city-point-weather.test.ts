import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {Miniflare} from 'miniflare';
import {nativeWeatherPoints,visibleCityWeather,weatherPoint,WeatherLimit} from '../src/server/weather-access';import {weatherLocation} from '../src/weather-point';
const setup=async()=>{const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2025-04-01',d1Databases:['DB']});const db=await mf.getD1Database('DB');for(const sql of readFileSync('migrations/0001_weather_cache.sql','utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();return {mf,db};};
const cities=[{lat:25.214912,lon:55.286946},{lat:25.34,lon:55.41}];
test('Dubai-area city labels and point details reuse identical native coordinates, time and full weather cache',async()=>{
 const {mf,db}=await setup(),original=globalThis.fetch;let calls=0;
 try{globalThis.fetch=async(input)=>{calls++;const u=new URL(String(input)),lat=u.searchParams.get('latitude')!.split(',').map(Number),lon=u.searchParams.get('longitude')!.split(',').map(Number);assert.deepEqual(lat,[25.2149,25.34]);assert.deepEqual(lon,[55.2869,55.41]);assert.equal(u.searchParams.get('elevation'),'nan,nan');assert.equal(u.searchParams.get('models'),'best_match');assert.ok(u.searchParams.get('current')!.includes('apparent_temperature'));return Response.json(lat.map((v,i)=>({latitude:v,longitude:lon[i],current:{time:'2026-11-03T15:30',temperature_2m:i?29.8:30.6,apparent_temperature:32},current_units:{temperature_2m:'°C'}})));};
 const batch=await nativeWeatherPoints(db,cities,'a');assert.equal(batch.pending,false);
 for(let i=0;i<cities.length;i++){const p=cities[i],r=await weatherPoint(new Request(`https://ionize.club/api/globe/point?lat=${p.lat}&lon=${p.lon}`),db,'b');assert.deepEqual(await r.json(),batch.points[i].weather);}
 await nativeWeatherPoints(db,[...cities].reverse(),'c');assert.equal(calls,1,'another user and different ordering must reuse individual points');const usage=await db.prepare("SELECT used FROM globe_weather_usage WHERE bucket LIKE 'global-day:%'").first<{used:number}>();assert.equal(usage?.used,2,'charge only native locations fetched');
 await db.prepare('UPDATE globe_weather_cache SET expires_at=0 WHERE cache_key=?').bind(weatherLocation(cities[1].lat,cities[1].lon)!.key).run();globalThis.fetch=async(input)=>{calls++;assert.equal(new URL(String(input)).searchParams.get('latitude'),'25.34');return Response.json({latitude:25.34,longitude:55.41,current:{time:'2026-11-03T15:45',temperature_2m:29.5},current_units:{temperature_2m:'°C'}});};const newer=await nativeWeatherPoints(db,cities,'a');assert.equal(newer.points[0].weather.current.temperature_2m,30.6);assert.equal(newer.points[1].weather.current.temperature_2m,29.5);assert.equal(calls,2);
 }finally{globalThis.fetch=original;await mf.dispose();}
});
test('overlapping city and detail requests coalesce and missing values stay missing',async()=>{
 const {mf,db}=await setup(),original=globalThis.fetch;let calls=0;let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 try{globalThis.fetch=async()=>{calls++;entered();await gate;return Response.json({latitude:25.2149,longitude:55.2869,current:{time:'2026-11-03T15:30',temperature_2m:null},current_units:{temperature_2m:'°C'}});};const first=nativeWeatherPoints(db,[cities[0]],'a');await started;const second=await nativeWeatherPoints(db,[cities[0]],'b');assert.equal(second.pending,true);assert.equal(second.points.length,0);assert.equal(calls,1);release();await first;const detail=await (await weatherPoint(new Request('https://ionize.club/api/globe/point?lat=25.214912&lon=55.286946'),db,'b')).json();assert.equal(detail.current.temperature_2m,null);assert.equal(calls,1);
 }finally{release?.();globalThis.fetch=original;await mf.dispose();}
});
test('native city batch rejects malformed or excessive requests and releases leases after provider failure',async()=>{
 const {mf,db}=await setup(),original=globalThis.fetch;let calls=0;
 try{globalThis.fetch=async()=>{calls++;throw Error('offline');};for(const points of ['', '91,0','NaN,2','1,','1,2,3',Array(25).fill('1,2').join(';')])assert.equal((await visibleCityWeather(new Request('https://ionize.club/api/globe/city-points?'+new URLSearchParams({points})),db,'a')).status,400);assert.equal(calls,0);
 await assert.rejects(()=>nativeWeatherPoints(db,[cities[0]],'a'),/offline/);const lease=await db.prepare('SELECT lease_until FROM globe_weather_cache WHERE cache_key=?').bind(weatherLocation(cities[0].lat,cities[0].lon)!.key).first<{lease_until:number}>();assert.equal(lease?.lease_until,0);
 await db.prepare("UPDATE globe_weather_usage SET used=8000 WHERE bucket LIKE 'global-day:%'").run();await assert.rejects(()=>nativeWeatherPoints(db,[cities[1]],'a'),WeatherLimit);assert.equal(calls,1);
 }finally{globalThis.fetch=original;await mf.dispose();}
});
