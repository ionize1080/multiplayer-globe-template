import {satelliteView,selectSatelliteScene,satelliteProcess,type SatelliteManifest,type SatelliteMode} from '../satellite';
import {digest} from './globe-auth';
import {weatherData} from './weather-access';
type SatelliteEnv=Pick<Env,'MAIL_DB'>&{CDSE_CLIENT_ID?:string;CDSE_CLIENT_SECRET?:string};
export class SatelliteError extends Error{constructor(message:string,readonly status=503){super(message);}}
const TOKEN_URL='https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',API='https://sh.dataspace.copernicus.eu';
// Reusable service credential only. Never store request objects, user sessions or I/O promises here.
let token:{client:string;value:string;expires:number}|null=null;
async function accessToken(env:SatelliteEnv,signal:AbortSignal){
 if(!env.CDSE_CLIENT_ID||!env.CDSE_CLIENT_SECRET)throw new SatelliteError('近期卫星服务尚未配置');
 if(token?.client===env.CDSE_CLIENT_ID&&token.expires>Date.now()+60000)return token.value;
 const r=await fetch(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:env.CDSE_CLIENT_ID,client_secret:env.CDSE_CLIENT_SECRET}),signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
 if(!r.ok){await r.body?.cancel();throw new SatelliteError('卫星服务授权暂不可用，请稍后重试');}
 const d=await r.json() as {access_token?:string;expires_in?:number};if(!d.access_token||!Number.isFinite(d.expires_in))throw new SatelliteError('卫星服务授权暂不可用');
 token={client:env.CDSE_CLIENT_ID,value:d.access_token,expires:Date.now()+Number(d.expires_in)*1000};return token.value;
}
async function cdse(env:SatelliteEnv,path:'/api/v1/catalog/1.0.0/search'|'/api/v1/process',body:unknown,signal=AbortSignal.timeout(30000)){
 for(let attempt=0;attempt<2;attempt++){
  const r=await fetch(API+path,{method:'POST',headers:{Authorization:'Bearer '+await accessToken(env,signal),'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  if(r.status===401&&attempt===0){await r.body?.cancel();token=null;continue;}
  if(!r.ok){await r.body?.cancel();throw new SatelliteError(r.status===429?'卫星服务配额繁忙，请稍后重试':'近期卫星影像暂不可用',r.status===429?429:503);}return r;
 }
 throw new SatelliteError('卫星服务授权暂不可用');
}
async function budget(db:D1Database,user:string,units:number){
 const now=Math.floor(Date.now()/1000),d=new Date(),month=d.toISOString().slice(0,7),monthEnd=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)/1000;
 const limits:[string,number,number,number][]=[[`cdse-requests-month:${month}`,1,8000,monthEnd],[`cdse-units-month:${month}`,units,8000,monthEnd],[`cdse-requests-minute:${Math.floor(now/60)}`,1,30,now+120],[`cdse-requests-day:${Math.floor(now/86400)}`,1,300,now+86400],[`cdse-user:${user}:${Math.floor(now/60)}`,1,24,now+120]];
 const results=await db.batch(limits.map(([key,cost,max,expires])=>db.prepare('INSERT INTO globe_weather_usage(bucket,used,expires_at) VALUES(?,?,?) ON CONFLICT(bucket) DO UPDATE SET used=used+excluded.used WHERE used+excluded.used<=? RETURNING used').bind(key,cost,expires,max)));
 if(results.some(r=>!r.results.length))throw new SatelliteError('近期卫星请求已达保护额度，请稍后再试',429);
}
export async function satelliteScene(request:Request,env:SatelliteEnv,user:string){
 const q=new URL(request.url).searchParams,values=['west','east','south','north'].map(k=>q.get(k));
 if(values.some(v=>!v?.trim()))return Response.json({error:'请提供完整视野范围'},{status:400});
 const view=satelliteView({west:Number(values[0]),east:Number(values[1]),south:Number(values[2]),north:Number(values[3])});
 if(!view)return Response.json({error:'请放大至城市或区域范围，暂不支持跨日期变更线的视野'},{status:400});
 const mode:SatelliteMode=q.get('mode')==='clear'?'clear':'latest';
 const data=await weatherData(env.MAIL_DB,`satellite-scene-v1:${mode}:${view.key}`,0,900,async()=>{
  const now=Date.now(),b=view.bounds,signal=AbortSignal.timeout(25000),features:unknown[]=[];
  // Search the view centre, so a tiny, newer sliver at the edge does not displace the centre's imagery.
  const query={collections:['sentinel-2-l2a'],intersects:{type:'Point',coordinates:[(b.west+b.east)/2,(b.south+b.north)/2]},datetime:new Date(now-30*86400000).toISOString()+'/'+new Date(now).toISOString(),limit:100,fields:{include:['id','properties.datetime','properties.eo:cloud_cover'],exclude:['assets','links']}};
  let next:unknown;
  for(let page=0;page<3;page++){
   await budget(env.MAIL_DB,user,0);
   const r=await cdse(env,'/api/v1/catalog/1.0.0/search',{...query,...(next===undefined?{}:{next})},signal);
   const payload=await r.json() as {features?:unknown[];context?:{next?:unknown}};
   if(!Array.isArray(payload.features)||payload.features.length>100)throw new SatelliteError('卫星目录返回异常，请重试');
   features.push(...payload.features);next=payload.context?.next;
   if(next===undefined||next===null)break;
   if(page===2||!(typeof next==='number'&&Number.isSafeInteger(next)&&next>=0))throw new SatelliteError('该区域卫星目录过于密集，请移动到附近区域重试');
  }
  const scene=selectSatelliteScene({features},mode,now);if(!scene)return {scene:null,checkedAt:new Date(now).toISOString()};
  const key=await digest(JSON.stringify([scene.id,scene.acquiredAt,view.key,view.width,view.height,'rgb-v1']));
  const manifest:SatelliteManifest={...scene,bounds:b,width:view.width,height:view.height,resolutionMeters:view.resolutionMeters,key,imageUrl:`/api/globe/satellite/image/${key}.png`,mode,checkedAt:new Date(now).toISOString()};
  await env.MAIL_DB.prepare('INSERT INTO globe_weather_cache(cache_key,payload,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at').bind('satellite-manifest:'+key,JSON.stringify(manifest),Math.floor(now/1000)+7*86400).run();
  return {scene:manifest};
 },undefined,undefined,{prefix:'satellite-cache',minute:1000,hour:10000,day:100000});
 return Response.json(data,{headers:{'Cache-Control':'private, max-age=300'}});
}
export async function satelliteImage(request:Request,env:SatelliteEnv,user:string,ctx:ExecutionContext){
 const match=/^\/api\/globe\/satellite\/image\/([a-f0-9]{64})\.png$/.exec(new URL(request.url).pathname);if(!match)return new Response(null,{status:404});
 const row=await env.MAIL_DB.prepare('SELECT payload FROM globe_weather_cache WHERE cache_key=? AND expires_at>?').bind('satellite-manifest:'+match[1],Math.floor(Date.now()/1000)).first<{payload:string}>();if(!row?.payload)return Response.json({error:'影像选择已过期，请重新加载'},{status:410});
 const cache=caches.default,cacheKey=new Request(`https://ionize.club/__satellite-cache/${match[1]}`),hit=await cache.match(cacheKey);
 const privateImage=(response:Response)=>new Response(response.body,{headers:{'Content-Type':'image/png','Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff'}});
 if(hit)return privateImage(hit);
 const now=Math.floor(Date.now()/1000),lease='satellite-render:'+match[1];
 const claimed=await env.MAIL_DB.prepare('INSERT INTO globe_weather_cache(cache_key,lease_until) VALUES(?,?) ON CONFLICT(cache_key) DO UPDATE SET lease_until=excluded.lease_until WHERE globe_weather_cache.lease_until<? RETURNING cache_key').bind(lease,now+90,now).first();
 if(!claimed)throw new SatelliteError('该区域影像正在生成，请稍后重试',429);
 let cachedInBackground=false;
 const release=()=>env.MAIL_DB.prepare('UPDATE globe_weather_cache SET lease_until=0 WHERE cache_key=?').bind(lease).run();
 try{
  const manifest=JSON.parse(row.payload) as SatelliteManifest;await budget(env.MAIL_DB,user,8);
  const r=await cdse(env,'/api/v1/process',satelliteProcess(manifest));if(!r.headers.get('Content-Type')?.includes('image/png')){await r.body?.cancel();throw new SatelliteError('卫星影像格式异常');}
  const response=new Response(r.body,{headers:{'Content-Type':'image/png','Cache-Control':'public, max-age=604800'}});
  ctx.waitUntil(cache.put(cacheKey,response.clone()).catch(()=>{}).finally(release));cachedInBackground=true;return privateImage(response);
 }finally{if(!cachedInBackground)await release();}
}
