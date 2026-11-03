import {weatherData,WeatherLimit} from './weather-access';
import {tileGeometry} from '../weather-tiles';
export async function weatherTile(request:Request,db:D1Database,userKey:string):Promise<Response>{
  const params=new URL(request.url).searchParams;
  const ids=['level','x','y'].map(key=>params.get(key));
  if(ids.some(id=>id===null||!/^\d{1,5}$/.test(id)))return Response.json({error:'无效的天气区域'},{status:400});
  const tile=tileGeometry(...ids.map(Number) as [number,number,number]);
  if(!tile)return Response.json({error:'无效的天气区域'},{status:400});
  const key=`weather-tile-v1:${tile.key}`;
  try{
    const data=await weatherData(db,key,25,3600,async()=>{
      const points:{lat:number;lon:number}[]=[];
      for(let y=0;y<5;y++)for(let x=0;x<5;x++)points.push({lat:Number((tile.south+y*tile.resolution).toFixed(6)),lon:Number((tile.west+x*tile.resolution).toFixed(6))});
      const upstream=new URL('https://api.open-meteo.com/v1/forecast');
      upstream.search=new URLSearchParams({latitude:points.map(p=>p.lat).join(','),longitude:points.map(p=>p.lon).join(','),current:'temperature_2m,wind_speed_10m,wind_direction_10m',wind_speed_unit:'ms',timezone:'UTC',forecast_days:'1',cell_selection:'nearest',models:'best_match'}).toString();
      const response=await fetch(upstream,{signal:AbortSignal.timeout(25000)});
      if(!response.ok)throw Error('Weather provider unavailable');
      type Row={current?:{time?:string;temperature_2m?:number;wind_speed_10m?:number;wind_direction_10m?:number}};
      const rows=await response.json() as Row[];
      if(!Array.isArray(rows)||rows.length!==25)throw Error('Invalid weather tile');
      const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:null;
      return {...tile,source:'Open-Meteo',fetchedAt:new Date().toISOString(),points:points.map((p,i)=>({...p,time:rows[i].current?.time?rows[i].current!.time+'Z':null,temperature:finite(rows[i].current?.temperature_2m),wind:finite(rows[i].current?.wind_speed_10m),direction:finite(rows[i].current?.wind_direction_10m)}))};
    },'viewport:'+userKey,{minute:300,day:1600});
    return Response.json(data,{headers:{'Cache-Control':'private, max-age=600'}});
  }catch(error){
    // Bounded stale fallback, explicitly labelled; never manufacture finer data.
    const cached=await db.prepare('SELECT payload FROM globe_weather_cache WHERE cache_key=? AND expires_at>?').bind(key,Math.floor(Date.now()/1000)-5*3600).first<{payload:string}>();
    if(cached?.payload)return Response.json({...JSON.parse(cached.payload),stale:true},{headers:{'Cache-Control':'private, max-age=60'}});
    if(error instanceof WeatherLimit)throw error;
    throw Error('Regional weather unavailable');
  }
}
export async function weatherGrid(request: Request, db: D1Database): Promise<Response> {
  const data=await weatherData(db,'global-grid-v2',264,10800,async()=>{
  const points: {lat:number,lon:number}[]=[];
  for(let lat=-75;lat<=75;lat+=15)for(let lon=-180;lon<180;lon+=15)points.push({lat,lon});
  const url=new URL('https://api.open-meteo.com/v1/forecast');
  url.search=new URLSearchParams({latitude:points.map(p=>p.lat).join(','),longitude:points.map(p=>p.lon).join(','),current:'temperature_2m,wind_speed_10m,wind_direction_10m',wind_speed_unit:'ms',timezone:'UTC',forecast_days:'1'}).toString();
  const res=await fetch(url,{signal:AbortSignal.timeout(25000)});
  if(!res.ok)throw new Error('Weather provider unavailable');
  type Entry={current?:{time?:string,temperature_2m?:number,wind_speed_10m?:number,wind_direction_10m?:number}};
  const rows=await res.json() as Entry[];
  if(!Array.isArray(rows)||rows.length!==points.length)throw new Error('Invalid weather grid');
  const data={source:'Open-Meteo',resolution:15,fetchedAt:new Date().toISOString(),points:points.map((p,i)=>{
    const c=rows[i].current;
    return {...p,time:c?.time ? c.time+'Z':null,temperature:typeof c?.temperature_2m==='number'?c.temperature_2m:null,wind:typeof c?.wind_speed_10m==='number'?c.wind_speed_10m:null,direction:typeof c?.wind_direction_10m==='number'?c.wind_direction_10m:null};
  })};
  return data;
  });
  return Response.json(data,{headers:{'Cache-Control':'private, max-age=600'}});
}
