import {normalizeQuery,parseCoordinates,photonResults,naturalPlace} from '../place-search';
import {weatherData} from './weather-access';
import {digest} from './globe-auth';
export async function searchPlaces(request:Request,db:D1Database,userKey:string){
 const query=normalizeQuery(new URL(request.url).searchParams.get('q')||'');
 if(query.length<2||query.length>160)return Response.json({error:'请输入 2–160 个字符的地名或经纬度'},{status:400});
 const natural=naturalPlace(query);if(natural)return Response.json({results:[natural],source:'IONIZE reference gazetteer'},{headers:{'Cache-Control':'private, max-age=86400'}});
 const coordinates=parseCoordinates(query);if(coordinates)return Response.json({results:[{...coordinates,id:'coordinates',name:'经纬度位置',detail:'WGS84',kind:'coordinate'}]});
 const data=await weatherData(db,'place-search-v1:'+await digest(query),1,86400,async()=>{
  const url=new URL('https://photon.komoot.io/api/');url.search=new URLSearchParams({q:query,limit:'8'}).toString();
  const r=await fetch(url,{headers:{'User-Agent':'ionize.club location explorer (https://ionize.club)','Accept-Language':'zh,en;q=0.8'},signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw Error('Search unavailable');return {results:photonResults(await r.json()),source:'Photon / OpenStreetMap'};
 },'search:'+userKey,{minute:6,day:100},{prefix:'search',minute:30,hour:600,day:2000});
 return Response.json(data,{headers:{'Cache-Control':'private, max-age=3600'}});
}
