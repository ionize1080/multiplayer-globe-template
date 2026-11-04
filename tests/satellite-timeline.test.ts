import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {satelliteRows,satelliteSequence,satelliteTarget,DAY} from '../src/satellite-timeline';
import {satelliteTimeline} from '../src/server/satellite';
const stamp=(s:string)=>Date.parse(s+'T12:00:00Z');
const scene=(s:string,cloudCover=10)=>({id:s,acquiredAt:new Date(stamp(s)).toISOString(),cloudCover});
test('calendar sampling clamps month ends and preserves leap days and UTC time',()=>{
 assert.equal(satelliteTarget(stamp('2024-03-31'),'month',1),stamp('2024-02-29'));
 assert.equal(satelliteTarget(stamp('2025-03-31'),'month',1),stamp('2025-02-28'));
 assert.equal(satelliteTarget(stamp('2026-01-31'),'quarter',1),stamp('2025-10-31'));
 assert.equal(satelliteTarget(stamp('2026-11-04'),'week',2),stamp('2026-10-21'));
});
test('catalogue validates rows, deduplicates acquisition times and excludes future observations',()=>{
 const features=[null,{},...['2026-11-04','2026-11-02','2026-11-02','2026-12-01'].map((s,i)=>({id:String(i),properties:{datetime:new Date(stamp(s)).toISOString(),'eo:cloud_cover':40-i}}))];
 const rows=satelliteRows(features,stamp('2026-01-01'),stamp('2026-11-05'));
 assert.equal(rows.length,2);assert.equal(rows[1].cloudCover,38);
});
test('missing intervals are skipped with no duplicate or blank frames; recent is chronological',()=>{
 const anchor=stamp('2026-11-04'),rows=[scene('2026-11-03'),scene('2026-10-27'),scene('2026-10-12'),scene('2026-08-01'),scene('2027-01-01')];
 const sequence=satelliteSequence(rows,'week',5,anchor);
 assert.equal(sequence.length,3);assert.deepEqual(sequence.map(s=>s.id),['2026-10-12','2026-10-27','2026-11-03']);
 assert.ok(sequence.every(s=>Math.abs(s.offsetDays)<=3.5));assert.equal(new Set(sequence.map(s=>s.acquiredAt)).size,sequence.length);
 assert.equal(satelliteSequence(rows,'recent',5,anchor).length,4);
 const boundary=satelliteSequence([{id:'edge',acquiredAt:new Date(anchor-3.5*DAY).toISOString(),cloudCover:null}],'week',2,anchor);assert.equal(boundary.length,1);
});
test('monthly and quarterly matching never fills long gaps outside tolerance',()=>{
 assert.equal(satelliteSequence([scene('2026-09-15')],'month',1,stamp('2026-10-31')).length,0);
 const rows=[scene('2026-07-01'),scene('2026-10-01')];
 assert.equal(satelliteSequence(rows,'quarter',5,stamp('2026-11-04')).length,2);
});
test('metadata paging never renders images; cached catalogue feeds sequences and bounded manifests',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2025-04-01',d1Databases:['DB']});const original=globalThis.fetch;let calls=0,images=0;
 try{
  const db=await mf.getD1Database('DB');for(const sql of readFileSync('migrations/0001_weather_cache.sql','utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();
  const env={MAIL_DB:db,CDSE_CLIENT_ID:'timeline-client',CDSE_CLIENT_SECRET:'test'};
  globalThis.fetch=async(input,init)=>{const url=String(input);if(url.includes('openid-connect'))return Response.json({access_token:'test',expires_in:3600});if(url.endsWith('/process')){images++;throw Error('Metadata must not render images');}
   calls++;const body=JSON.parse(String(init?.body));assert.equal(body.limit,100);assert.ok(body.fields.exclude.includes('assets'));
   // Deliberately unordered catalogue pages, plus an overlapping duplicate.
   return Response.json({features:(body.next===undefined?Array.from({length:8},(_,i)=>i+1):Array.from({length:8},(_,i)=>i+8)).map(i=>({id:'observation-'+i,properties:{datetime:`2025-10-${String(i).padStart(2,'0')}T12:00:00Z`,'eo:cloud_cover':i}})),context:body.next===undefined?{next:100}:{}});
  };
  const base='https://ionize.club/api/globe/satellite/timeline?west=103.8&east=104&south=1.2&north=1.4';
  for(const suffix of ['&count=31','&count=6','&interval=year','&page=-1','&month=2025-13','&month=2016-01'])assert.equal((await satelliteTimeline(new Request(base+suffix),env as never,'user')).status,400);
  assert.equal(calls,0);
  const first=await (await satelliteTimeline(new Request(base+'&kind=browse&month=2025-10'),env as never,'user')).json();
  assert.equal(first.scenes.length,10);assert.equal(first.total,15);assert.equal(first.hasMore,true);assert.equal(images,0);assert.equal(calls,2);
  const second=await (await satelliteTimeline(new Request(base+'&kind=browse&month=2025-10&page=1'),env as never,'other')).json();
  assert.equal(second.scenes.length,5);assert.equal(second.hasMore,false);assert.equal(calls,2);assert.equal(images,0);
  assert.ok(Date.parse(first.scenes[9].acquiredAt)>Date.parse(second.scenes[0].acquiredAt));
  const manifest=await db.prepare('SELECT payload FROM globe_weather_cache WHERE cache_key=?').bind('satellite-manifest:'+first.scenes[0].key).first<{payload:string}>();assert.ok(manifest?.payload);
  const sequence=await (await satelliteTimeline(new Request(base+'&kind=sequence&interval=quarter&count=5'),env as never,'user')).json();
  assert.ok(sequence.scenes.every((s:{width:number;height:number})=>s.width<=512&&s.height<=512));assert.equal(sequence.missing,5-sequence.scenes.length);assert.equal(images,0);
  const recent=await (await satelliteTimeline(new Request(base+'&kind=sequence&interval=recent&count=5'),env as never,'user')).json();assert.equal(recent.scenes.length,5);assert.equal(recent.missing,0);assert.equal(images,0);assert.ok(recent.scenes.every((s:{width:number})=>s.width<=512));
 }finally{globalThis.fetch=original;await mf.dispose();}
});
