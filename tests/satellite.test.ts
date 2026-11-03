import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {Miniflare} from 'miniflare';
import {satelliteView,selectSatelliteScene,satelliteProcess,type SatelliteManifest} from '../src/satellite';import {satelliteScene,satelliteImage,SatelliteError} from '../src/server/satellite';
test('satellite bounds reject unbounded, polar and dateline requests and preserve native resolution',()=>{
 for(const b of [{west:-180,east:180,south:-85,north:85},{west:179,east:-179,south:0,north:1},{west:0,east:1,south:85,north:90},{west:NaN,east:1,south:0,north:1}])assert.equal(satelliteView(b),null);
 const small=satelliteView({west:103.8,east:103.801,south:1.3,north:1.301})!;assert.equal(small.resolutionMeters,10);assert.ok(small.width<20);
 const wide=satelliteView({west:103,east:104,south:1,north:1.5})!;assert.ok(wide.width<=1024&&wide.height<=1024);assert.ok(wide.width>wide.height);assert.ok(wide.resolutionMeters>10);
});
test('latest and least cloudy select valid recent observations without trusting malformed dates or clouds',()=>{
 const now=Date.parse('2026-11-03T12:00:00Z');const features=[['new','2026-11-02T12:00:00Z',80],['clear','2026-10-29T12:00:00Z',2],['old','2026-09-01T12:00:00Z',0],['future','2027-01-01',0],['broken','invalid',0],['unknown','2026-11-01',-1]].map(([id,datetime,cloud])=>({id,properties:{datetime,'eo:cloud_cover':cloud}}));
 assert.equal(selectSatelliteScene({features},'latest',now)?.id,'new');assert.equal(selectSatelliteScene({features},'clear',now)?.id,'clear');assert.equal(selectSatelliteScene({features:[]},'latest',now),null);
});
test('authenticated service paginates catalogues, reuses token and image cache; bounds and monthly quota guard upstream requests',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2025-04-01',d1Databases:['DB']});const original=globalThis.fetch,originalCaches=globalThis.caches;let auth=0,catalogue=0,images=0;const pending:Promise<unknown>[]=[];const cached=new Map<string,Response>();
 try{
  const db=await mf.getD1Database('DB');for(const sql of readFileSync('migrations/0001_weather_cache.sql','utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();
  const env={MAIL_DB:db,CDSE_CLIENT_ID:'unit-client',CDSE_CLIENT_SECRET:'unit-secret'};const date=new Date(Date.now()-86400000).toISOString();
  globalThis.caches={default:{match:async(r:Request)=>cached.get(r.url)?.clone(),put:async(r:Request,s:Response)=>{cached.set(r.url,new Response(await s.arrayBuffer(),{headers:s.headers}));}}} as never;
  globalThis.fetch=async(input,init)=>{const url=String(input);if(url.includes('openid-connect')){auth++;return Response.json({access_token:'unit-token',expires_in:1800});}assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer unit-token');const body=JSON.parse(String(init?.body));if(url.endsWith('/search')){catalogue++;assert.deepEqual(body.intersects.type,'Point');if(body.next===undefined)return Response.json({features:[{id:'scene-1',properties:{datetime:date,'eo:cloud_cover':5}}],context:{next:1}});assert.equal(body.next,1);return Response.json({features:[{id:'scene-older',properties:{datetime:new Date(Date.parse(date)-86400000).toISOString(),'eo:cloud_cover':0}}]});}images++;assert.equal(url,'https://sh.dataspace.copernicus.eu/api/v1/process');assert.ok(body.output.width<=1024);assert.equal(body.evalscript.includes('dataMask'),true);assert.ok(Date.parse(body.input.data[0].dataFilter.timeRange.from)<=Date.parse(date));return new Response(new Uint8Array([137,80,78,71]),{headers:{'Content-Type':'image/png'}});};
  const req=new Request('https://ionize.club/api/globe/satellite/scene?west=103.8&east=103.9&south=1.25&north=1.35');
  const first=await (await satelliteScene(req,env as never,'a')).json() as {scene:SatelliteManifest};assert.equal(first.scene.acquiredAt,date);assert.ok(!JSON.stringify(first).includes('unit-token'));
  await satelliteScene(req,env as never,'b');assert.equal(catalogue,2);assert.equal(auth,1);
  const img=new Request('https://ionize.club'+first.scene.imageUrl),ctx={waitUntil:(p:Promise<unknown>)=>pending.push(p)};
  const response=await satelliteImage(img,env as never,'a',ctx as never);assert.equal(response.status,200);assert.match(response.headers.get('Cache-Control')!,/private/);await response.arrayBuffer();await Promise.all(pending);await satelliteImage(img,env as never,'b',ctx as never);assert.equal(images,1);assert.equal(auth,1);
  assert.equal((await satelliteScene(new Request('https://ionize.club/api/globe/satellite/scene?west=0&east=180&south=0&north=80'),env as never,'a')).status,400);assert.equal(catalogue,2);
  await db.prepare("UPDATE globe_weather_usage SET used=8000 WHERE bucket LIKE 'cdse-requests-month:%'").run();await assert.rejects(()=>satelliteScene(new Request(req.url+'&mode=clear'),env as never,'a'),SatelliteError);assert.equal(catalogue,2);
  const process=satelliteProcess(first.scene);assert.equal(process.input.data[0].dataFilter.mosaickingOrder,'mostRecent');assert.equal((await satelliteImage(new Request('https://ionize.club/api/globe/satellite/image/'+ 'a'.repeat(64)+'.png'),env as never,'a',ctx as never)).status,410);
 }finally{globalThis.fetch=original;globalThis.caches=originalCaches;await mf.dispose();}
});
