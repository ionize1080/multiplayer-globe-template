export class WeatherLimit extends Error {}
/** Shared D1 cache/quota applies across visitors and Cloudflare regions. */
export async function weatherData(db:D1Database,key:string,cost:number,ttl:number,load:()=>Promise<unknown>,userKey?:string):Promise<unknown> {
  const now=Math.floor(Date.now()/1000);
  const cached=await db.prepare('SELECT payload FROM globe_weather_cache WHERE cache_key=? AND expires_at>?').bind(key,now).first<{payload:string}>();
  if(cached?.payload)return JSON.parse(cached.payload);
  const claim=await db.prepare('INSERT INTO globe_weather_cache(cache_key,lease_until) VALUES(?,?) ON CONFLICT(cache_key) DO UPDATE SET lease_until=excluded.lease_until WHERE globe_weather_cache.lease_until<? RETURNING cache_key').bind(key,now+35,now).first();
  if(!claim)throw new WeatherLimit('该区域正在更新，请稍后重试');
  try {
    const limits:[string,number,number][]=[['global-minute:'+Math.floor(now/60),550,now+120],['global-hour:'+Math.floor(now/3600),4400,now+7200],['global-day:'+Math.floor(now/86400),8000,now+86400]];
    if(userKey)limits.push(['user-minute:'+userKey+':'+Math.floor(now/60),10,now+120],['user-day:'+userKey+':'+Math.floor(now/86400),400,now+86400]);
    const results=await db.batch(limits.map(([bucket,max,expiry])=>db.prepare('INSERT INTO globe_weather_usage(bucket,used,expires_at) VALUES(?,?,?) ON CONFLICT(bucket) DO UPDATE SET used=used+excluded.used WHERE used+excluded.used<=? RETURNING used').bind(bucket,cost,expiry,max)));
    if(results.some(r=>!r.results.length))throw new WeatherLimit('已达到天气查询额度，请稍后再试');
    const data=await load();
    await db.batch([
      db.prepare('UPDATE globe_weather_cache SET payload=?,expires_at=?,lease_until=0 WHERE cache_key=?').bind(JSON.stringify(data),now+ttl,key),
      db.prepare('DELETE FROM globe_weather_usage WHERE expires_at<?').bind(now),
      db.prepare('DELETE FROM globe_weather_cache WHERE expires_at<? AND lease_until<?').bind(now-86400,now)
    ]);
    return data;
  }catch(error){await db.prepare('UPDATE globe_weather_cache SET lease_until=0 WHERE cache_key=?').bind(key).run();throw error;}
}

export async function weatherPoint(request:Request,db:D1Database,userKey:string):Promise<Response> {
  const url=new URL(request.url),latText=url.searchParams.get('lat'),lonText=url.searchParams.get('lon');
  const lat=Number(latText),lon=Number(lonText);
  if(!latText||!lonText||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return Response.json({error:'无效的经纬度'},{status:400,headers:{'Cache-Control':'no-store'}});
  const latitude=Number(lat.toFixed(2)),longitude=Number(lon.toFixed(2));
  const data=await weatherData(db,`point:${latitude}:${longitude}`,1,1800,async()=>{
    const upstream=new URL('https://api.open-meteo.com/v1/forecast');
    upstream.search=new URLSearchParams({latitude:String(latitude),longitude:String(longitude),current:'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m',wind_speed_unit:'ms',timezone:'UTC',forecast_days:'1',cell_selection:'nearest'}).toString();
    const response=await fetch(upstream,{signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('Weather unavailable');
    const payload=await response.json() as {latitude:number,longitude:number,current:Record<string,number|string|null>,current_units:Record<string,string>};
    if(!payload.current?.time||!Number.isFinite(payload.latitude)||!Number.isFinite(payload.longitude))throw new Error('Invalid weather response');
    return {source:'Open-Meteo',time:payload.current.time+'Z',sampleLatitude:payload.latitude,sampleLongitude:payload.longitude,current:payload.current,units:payload.current_units,fetchedAt:new Date().toISOString()};
  },userKey);
  return Response.json(data,{headers:{'Cache-Control':'private, max-age=300'}});
}
