import {locationDetails} from '../location-details';
import {weatherData} from './weather-access';
export async function pointLocation(request:Request,db:D1Database,userKey:string){
 const q=new URL(request.url).searchParams,latText=q.get('lat'),lonText=q.get('lon'),lat=Number(latText),lon=Number(lonText);
 if(!latText?.trim()||!lonText?.trim()||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return Response.json({error:'无效的经纬度'},{status:400});
 const latitude=Number(lat.toFixed(5)),longitude=Number(lon.toFixed(5));
 const data=await weatherData(db,`location-v1:${latitude}:${longitude}`,1,86400,async()=>{
  const url=new URL('https://photon.komoot.io/reverse');url.search=new URLSearchParams({lat:String(latitude),lon:String(longitude),radius:'1',limit:'1'}).toString();
  const response=await fetch(url,{headers:{'User-Agent':'ionize.club location explorer (https://ionize.club)','Accept-Language':'zh,en;q=0.8'},signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error('所在地暂不可用');const payload=await response.json() as {features?:unknown[]};if(!Array.isArray(payload.features))throw Error('无效的所在地数据');
  return locationDetails(payload,latitude,longitude);
 },'location:'+userKey,{minute:15,day:250},{prefix:'search',minute:30,hour:600,day:2000});
 return Response.json(data,{headers:{'Cache-Control':'private, max-age=3600'}});
}
