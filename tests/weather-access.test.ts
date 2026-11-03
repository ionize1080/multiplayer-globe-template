import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {weatherTile} from '../src/server/weather-grid';
import {weatherData,weatherPoint,WeatherLimit} from '../src/server/weather-access';
test('weather cache shares results, coalesces misses, and enforces a global hourly budget',async()=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2025-04-01',d1Databases:['DB']});
  try {
    const db=await mf.getD1Database('DB');
    for(const sql of readFileSync('migrations/0001_weather_cache.sql','utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();
    let count=0;const load=async()=>{count++;return {temperature:25};};
    assert.deepEqual(await weatherData(db,'same-point',1,1800,load,'user-a'),{temperature:25});
    assert.deepEqual(await weatherData(db,'same-point',1,1800,load,'user-b'),{temperature:25});
    assert.equal(count,1,'another user reuses the cached result');
    const concurrent=await Promise.allSettled([weatherData(db,'new-point',1,1800,load),weatherData(db,'new-point',1,1800,load)]);
    assert.ok(concurrent.some(r=>r.status==='fulfilled'));assert.equal(count,2,'concurrent requests make at most one upstream request');
    await assert.rejects(()=>weatherData(db,'oversized',551,1800,load),WeatherLimit);assert.equal(count,2,'oversized first reservation cannot bypass the limit');
    for(const query of ['level=8&x=0&y=0','level=0&x=18&y=0','level=0&x=-1&y=0','level=&x=0&y=0'])assert.equal((await weatherTile(new Request('https://ionize.club/api/globe/tile?'+query),db,'a')).status,400);
    const now=Math.floor(Date.now()/1000),bucket='global-hour:'+Math.floor(now/3600);
    await db.prepare('UPDATE globe_weather_usage SET used=4400 WHERE bucket=?').bind(bucket).run();
    await assert.rejects(()=>weatherData(db,'over-budget',1,1800,load),WeatherLimit);assert.equal(count,2);
    for(const query of ['lat=91&lon=1','lat=NaN&lon=1','lat=&lon=0','lat=0&lon=181'])assert.equal((await weatherPoint(new Request('https://ionize.club/api/globe/point?'+query),db,'a')).status,400);
  }finally{await mf.dispose();}
});

test('regional endpoint batches 25 WGS84 locations, shares cache and labels a bounded stale fallback',async()=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2025-04-01',d1Databases:['DB']});
  const original=globalThis.fetch;let calls=0;
  try{
    const db=await mf.getD1Database('DB');for(const sql of readFileSync('migrations/0001_weather_cache.sql','utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();
    globalThis.fetch=async(input)=>{
      calls++;const url=new URL(String(input));assert.equal(url.hostname,'api.open-meteo.com');
      const lat=url.searchParams.get('latitude')!.split(',').map(Number),lon=url.searchParams.get('longitude')!.split(',').map(Number);
      assert.equal(lat.length,25);assert.equal(lat[0],1);assert.equal(lon[0],103);assert.equal(lat[24],2);assert.equal(lon[24],104);
      assert.equal(url.searchParams.get('cell_selection'),'nearest');assert.equal(url.searchParams.get('elevation'),'nan','lake cells must not receive a second lapse-rate correction');
      return Response.json(lat.map(()=>({current:{time:'2026-11-03T08:00',temperature_2m:28,wind_speed_10m:2,wind_direction_10m:359}})));
    };
    const request=new Request('https://ionize.club/api/globe/tile?level=4&x=283&y=91');
    const first=await weatherTile(request,db,'user-a'),data=await first.json() as {points:unknown[],resolution:number};
    assert.equal(data.points.length,25);assert.equal(data.resolution,.25);assert.match(first.headers.get('Cache-Control')!,/private/);
    await weatherTile(request,db,'user-b');assert.equal(calls,1);
    const usage=await db.prepare("SELECT used FROM globe_weather_usage WHERE bucket LIKE 'global-day:%'").first<{used:number}>();assert.equal(usage?.used,25);
    await db.prepare('UPDATE globe_weather_cache SET expires_at=?').bind(Math.floor(Date.now()/1000)-1).run();
    globalThis.fetch=async()=>{throw Error('upstream unavailable');};
    const stale=await (await weatherTile(request,db,'user-a')).json() as {stale:boolean};assert.equal(stale.stale,true);
    await db.prepare('UPDATE globe_weather_cache SET expires_at=?').bind(Math.floor(Date.now()/1000)-6*3600).run();
    await assert.rejects(()=>weatherTile(request,db,'user-a'),/Regional weather unavailable/);
  }finally{globalThis.fetch=original;await mf.dispose();}
});
