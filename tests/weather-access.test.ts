import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
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
    const now=Math.floor(Date.now()/1000),bucket='global-hour:'+Math.floor(now/3600);
    await db.prepare('UPDATE globe_weather_usage SET used=4400 WHERE bucket=?').bind(bucket).run();
    await assert.rejects(()=>weatherData(db,'over-budget',1,1800,load),WeatherLimit);assert.equal(count,2);
    for(const query of ['lat=91&lon=1','lat=NaN&lon=1','lat=&lon=0','lat=0&lon=181'])assert.equal((await weatherPoint(new Request('https://ionize.club/api/globe/point?'+query),db,'a')).status,400);
  }finally{await mf.dispose();}
});
