import {weatherLocation,type PointWeather,type NativeWeatherPoint} from '../weather-point';
export class WeatherLimit extends Error {}
/** Shared D1 cache/quota applies across visitors and Cloudflare regions. */
export async function weatherData(db:D1Database,key:string,cost:number,ttl:number,load:()=>Promise<unknown>,userKey?:string,userBudget={minute:10,day:400},quota={prefix:'global',minute:550,hour:4400,day:8000}):Promise<unknown> {
  const now=Math.floor(Date.now()/1000);
  const cached=await db.prepare('SELECT payload FROM globe_weather_cache WHERE cache_key=? AND expires_at>?').bind(key,now).first<{payload:string}>();
  if(cached?.payload)return JSON.parse(cached.payload);
  const claim=await db.prepare('INSERT INTO globe_weather_cache(cache_key,lease_until) VALUES(?,?) ON CONFLICT(cache_key) DO UPDATE SET lease_until=excluded.lease_until WHERE globe_weather_cache.lease_until<? AND globe_weather_cache.expires_at<=? RETURNING cache_key').bind(key,now+35,now,now).first();
  if(!claim){
    const completed=await db.prepare('SELECT payload FROM globe_weather_cache WHERE cache_key=? AND expires_at>?').bind(key,now).first<{payload:string}>();
    if(completed?.payload)return JSON.parse(completed.payload);
    throw new WeatherLimit('该区域正在更新，请稍后重试');
  }
  try {
    await weatherBudget(db,cost,userKey,userBudget,quota);
    const data=await load();
    await db.batch([
      db.prepare('UPDATE globe_weather_cache SET payload=?,expires_at=?,lease_until=0 WHERE cache_key=?').bind(JSON.stringify(data),now+ttl,key),
      db.prepare('DELETE FROM globe_weather_usage WHERE expires_at<?').bind(now),
      db.prepare('DELETE FROM globe_weather_cache WHERE expires_at<? AND lease_until<?').bind(now-86400,now)
    ]);
    return data;
  }catch(error){await db.prepare('UPDATE globe_weather_cache SET lease_until=0 WHERE cache_key=?').bind(key).run();throw error;}
}

async function weatherBudget(db:D1Database,cost:number,userKey?:string,userBudget={minute:10,day:400},quota={prefix:'global',minute:550,hour:4400,day:8000}){
 const now=Math.floor(Date.now()/1000);
    const limits:[string,number,number][]=[[quota.prefix+'-minute:'+Math.floor(now/60),quota.minute,now+120],[quota.prefix+'-hour:'+Math.floor(now/3600),quota.hour,now+7200],[quota.prefix+'-day:'+Math.floor(now/86400),quota.day,now+86400]];
    if(userKey)limits.push(['user-minute:'+userKey+':'+Math.floor(now/60),userBudget.minute,now+120],['user-day:'+userKey+':'+Math.floor(now/86400),userBudget.day,now+86400]);
    const results=await db.batch(limits.map(([bucket,max,expiry])=>db.prepare('INSERT INTO globe_weather_usage(bucket,used,expires_at) SELECT ?,?,? WHERE ?<=? ON CONFLICT(bucket) DO UPDATE SET used=used+excluded.used WHERE used+excluded.used<=? RETURNING used').bind(bucket,cost,expiry,cost,max,max)));
    if(results.some(r=>!r.results.length))throw new WeatherLimit('已达到天气查询额度，请稍后再试');
}

const currentFields='temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
/** Labels and details share identical coordinates, fields, model selection and cache rows. */
export async function nativeWeatherPoints(db:D1Database,locations:{lat:number;lon:number}[],userKey:string){
 const points=[...new Map(locations.map(p=>{const v=weatherLocation(p.lat,p.lon);if(!v)throw Error('Invalid weather coordinate');return [v.key,v] as const;})).values()];
 if(!points.length||points.length>24)throw Error('Invalid weather batch');
 const now=Math.floor(Date.now()/1000),lease=now+35,result=new Map<string,NativeWeatherPoint>();
 const rows=await db.batch(points.map(p=>db.prepare('SELECT payload FROM globe_weather_cache WHERE cache_key=? AND expires_at>?').bind(p.key,now)));
 const missing=points.filter((p,i)=>{const row=rows[i].results[0] as {payload?:string}|undefined;if(row?.payload){result.set(p.key,{lat:p.lat,lon:p.lon,weather:JSON.parse(row.payload)});return false;}return true;});
 const claims=missing.length?await db.batch(missing.map(p=>db.prepare('INSERT INTO globe_weather_cache(cache_key,lease_until) VALUES(?,?) ON CONFLICT(cache_key) DO UPDATE SET lease_until=excluded.lease_until WHERE globe_weather_cache.lease_until<? AND globe_weather_cache.expires_at<=? RETURNING cache_key').bind(p.key,lease,now,now))):[];
 const claimed=missing.filter((_,i)=>claims[i].results.length>0);
 if(claimed.length)try{
  await weatherBudget(db,claimed.length,'native-point:'+userKey,{minute:180,day:1600});
  const upstream=new URL('https://api.open-meteo.com/v1/forecast');
  upstream.search=new URLSearchParams({latitude:claimed.map(p=>p.lat).join(','),longitude:claimed.map(p=>p.lon).join(','),current:currentFields,wind_speed_unit:'ms',timezone:'UTC',forecast_days:'1',elevation:claimed.map(()=>'nan').join(','),cell_selection:'nearest',models:'best_match'}).toString();
  const response=await fetch(upstream,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('Weather unavailable');
  type Row={latitude:number;longitude:number;current:Record<string,number|string|null>;current_units:Record<string,string>};
  const payload=await response.json() as Row|Row[],data=Array.isArray(payload)?payload:[payload];
  if(data.length!==claimed.length||data.some(p=>typeof p.current?.time!=='string'||!Number.isFinite(p.latitude)||!Number.isFinite(p.longitude)))throw Error('Invalid weather response');
  const fetchedAt=new Date().toISOString();
  const fresh=claimed.map((p,i)=>({key:p.key,lat:p.lat,lon:p.lon,weather:{source:'Open-Meteo',temperatureKind:'air_2m',downscaling:'disabled',time:data[i].current.time+'Z',sampleLatitude:data[i].latitude,sampleLongitude:data[i].longitude,current:data[i].current,units:data[i].current_units,fetchedAt} satisfies PointWeather}));
  await db.batch([...fresh.map(p=>db.prepare('UPDATE globe_weather_cache SET payload=?,expires_at=?,lease_until=0 WHERE cache_key=? AND lease_until=?').bind(JSON.stringify(p.weather),Math.floor(Date.now()/1000)+900,p.key,lease)),db.prepare('DELETE FROM globe_weather_usage WHERE expires_at<?').bind(now),db.prepare('DELETE FROM globe_weather_cache WHERE expires_at<? AND lease_until<?').bind(now-86400,now)]);
  for(const p of fresh)result.set(p.key,{lat:p.lat,lon:p.lon,weather:p.weather});
 }finally{await db.batch(claimed.map(p=>db.prepare('UPDATE globe_weather_cache SET lease_until=0 WHERE cache_key=? AND lease_until=?').bind(p.key,lease)));}
 // A concurrent point/detail request may have completed while this batch was fetching.
 const remaining=points.filter(p=>!result.has(p.key));
 if(remaining.length){const completed=await db.batch(remaining.map(p=>db.prepare('SELECT payload FROM globe_weather_cache WHERE cache_key=? AND expires_at>?').bind(p.key,Math.floor(Date.now()/1000))));for(let i=0;i<remaining.length;i++){const row=completed[i].results[0] as {payload?:string}|undefined;if(row?.payload){const p=remaining[i];result.set(p.key,{lat:p.lat,lon:p.lon,weather:JSON.parse(row.payload)});}}}
 return {points:points.flatMap(p=>result.has(p.key)?[result.get(p.key)!]:[]),pending:result.size<points.length};
}
export async function weatherPoint(request:Request,db:D1Database,userKey:string):Promise<Response> {
 const url=new URL(request.url),latText=url.searchParams.get('lat'),lonText=url.searchParams.get('lon');
 if(!latText?.trim()||!lonText?.trim()||!weatherLocation(Number(latText),Number(lonText)))return Response.json({error:'无效的经纬度'},{status:400,headers:{'Cache-Control':'no-store'}});
 const data=await nativeWeatherPoints(db,[{lat:Number(latText),lon:Number(lonText)}],userKey);
 if(!data.points.length)return Response.json({error:'该点位正在更新，请稍后重试',code:'POINT_UPDATING'},{status:429,headers:{'Cache-Control':'no-store','Retry-After':'1'}});
 return Response.json(data.points[0].weather,{headers:{'Cache-Control':'private, no-store'}});
}
export async function visibleCityWeather(request:Request,db:D1Database,userKey:string){
 const raw=new URL(request.url).searchParams.get('points')||'',parts=raw.split(';');
 const locations=parts.map(p=>{const a=p.split(',');return a.length===2&&a.every(s=>s.trim())?weatherLocation(Number(a[0]),Number(a[1])):null;});
 if(parts.length>24||locations.some(p=>!p))return Response.json({error:'无效的城市坐标，单批最多 24 个地点'},{status:400,headers:{'Cache-Control':'no-store'}});
 const data=await nativeWeatherPoints(db,locations as {lat:number;lon:number}[],userKey);
 return Response.json(data,{headers:{'Cache-Control':'private, no-store'}});
}
