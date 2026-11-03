import {weatherCities} from '../weather-cities';
import {weatherData} from './weather-access';
export async function cityWeather(db:D1Database){
  const data=await weatherData(db,'major-city-weather-v1',weatherCities.length,3600,async()=>{
    const url=new URL('https://api.open-meteo.com/v1/forecast');
    url.search=new URLSearchParams({latitude:weatherCities.map(p=>p.lat).join(','),longitude:weatherCities.map(p=>p.lon).join(','),current:'temperature_2m',timezone:'UTC',forecast_days:'1',elevation:weatherCities.map(()=>'nan').join(','),cell_selection:'nearest'}).toString();
    const response=await fetch(url,{signal:AbortSignal.timeout(25000)});
    if(!response.ok)throw Error('City weather unavailable');
    const rows=await response.json() as {current?:{time?:string;temperature_2m?:number|null}}[];
    if(!Array.isArray(rows)||rows.length!==weatherCities.length)throw Error('Invalid city weather');
    return {fetchedAt:new Date().toISOString(),source:'Open-Meteo',cities:weatherCities.map((p,i)=>({...p,temperature:typeof rows[i].current?.temperature_2m==='number'&&Number.isFinite(rows[i].current?.temperature_2m)?rows[i].current!.temperature_2m:null,time:rows[i].current?.time?rows[i].current!.time+'Z':null}))};
  });
  return Response.json(data,{headers:{'Cache-Control':'private, max-age=600'}});
}
