import {normalizeQuery,parseCoordinates,photonResults,naturalPlace,searchQueries,mergeSearchResults,clarifyWashington} from '../place-search';
import {weatherData} from './weather-access';
import {digest} from './globe-auth';
export async function searchPlaces(request:Request,db:D1Database,userKey:string){
 const query=normalizeQuery(new URL(request.url).searchParams.get('q')||'');
 if(query.length<2||query.length>160)return Response.json({error:'请输入 2–160 个字符的地名或经纬度'},{status:400});
 const natural=naturalPlace(query);if(natural)return Response.json({results:[natural],source:'IONIZE reference gazetteer'},{headers:{'Cache-Control':'private, max-age=86400'}});
 const coordinates=parseCoordinates(query);if(coordinates)return Response.json({results:[{...coordinates,id:'coordinates',name:'经纬度位置',detail:'WGS84',kind:'coordinate'}]});
 const queries=searchQueries(query);
 const data=await weatherData(db,'place-search-v2:'+await digest(query),queries.length,86400,async()=>{
  const groups=await Promise.allSettled(queries.map(async q=>{const url=new URL('https://photon.komoot.io/api/');url.search=new URLSearchParams({q,limit:'8'}).toString();
   const r=await fetch(url,{headers:{'User-Agent':'ionize.club location explorer (https://ionize.club)','Accept-Language':'zh,en;q=0.8'},signal:AbortSignal.timeout(12000)});
   if(!r.ok)throw Error('Search unavailable');return photonResults(await r.json());}));
  if(groups.every(g=>g.status==='rejected'))throw Error('Search unavailable');
  return {results:clarifyWashington(mergeSearchResults(groups.flatMap(g=>g.status==='fulfilled'?[g.value]:[])),query),source:'Photon / OpenStreetMap'};
 },'search:'+userKey,{minute:12,day:200},{prefix:'search',minute:30,hour:600,day:2000});
 return Response.json(data,{headers:{'Cache-Control':'private, max-age=3600'}});
}
