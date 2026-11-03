import {weatherData} from './weather-access';
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
