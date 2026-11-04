import {boundsGeometry,type AtlasBounds,type AtlasStats,type SpeciesRow} from '../atlas-stats';
import {splitBounds} from '../atlas';
import {occurrenceRecord} from './atlas';
import {bioGroup,normalizeTaxonomy} from '../taxonomy';
import {chineseName,textValue} from '../species';
const PAGE=20;
async function json(url:URL|string){const r=await fetch(url,{signal:AbortSignal.timeout(12000),cf:{cacheEverything:true,cacheTtlByStatus:{'200-299':600,'400-599':0}}});if(!r.ok)throw Error('GBIF unavailable');return await r.json() as any;}
export async function atlasStats(request:Request){
 const p=new URL(request.url).searchParams,layer=p.get('layer'),offset=Number(p.get('offset')||0),values=['west','south','east','north'].map(k=>p.get(k));
 const [w,s,e,n]=values.map(Number),b:AtlasBounds={west:w,south:s,east:e,north:n};
 const species=p.has('species')?Number(p.get('species')):null;
 if(!['plants','animals'].includes(layer||'')||values.some(v=>!v?.trim())||!splitBounds(w,s,e,n).length||!Number.isInteger(offset)||offset<0||offset>10000||species!==null&&(!Number.isSafeInteger(species)||species<=0))return Response.json({error:'统计范围或筛选无效'},{status:400});
 const u=new URL('https://api.gbif.org/v1/occurrence/search');u.search=new URLSearchParams({geometry:boundsGeometry(b),kingdomKey:layer==='plants'?'6':'1',hasCoordinate:'true',hasGeospatialIssue:'false',occurrenceStatus:'PRESENT',limit:species?'20':'0'}).toString();
 if(species){u.searchParams.set('speciesKey',String(species));u.searchParams.set('offset',String(offset));}
 else {u.searchParams.set('facet','speciesKey');u.searchParams.set('facetLimit',String(PAGE+1));u.searchParams.set('facetOffset',String(offset));}
 try{
  const result=await json(u);
  if(species)return Response.json({records:(result.results||[]).map((r:any)=>occurrenceRecord(r,layer as 'plants'|'animals')).filter(Boolean),total:result.count,hasMore:!result.endOfRecords},{headers:{'Cache-Control':'private, max-age=600'}});
  const facets=result.facets?.find((f:any)=>f.field==='SPECIES_KEY')?.counts||[];
  const rows:SpeciesRow[]=facets.slice(0,PAGE).map((f:any)=>({key:Number(f.name),name:`物种 ${f.name}`,chineseName:'',count:f.count,group:layer==='plants'?'plant':'unknown'}));
  let cursor=0,partial=false;
  await Promise.all(Array.from({length:4},async()=>{while(cursor<rows.length){const row=rows[cursor++];try{const t=normalizeTaxonomy(await json(`https://api.gbif.org/v1/species/${row.key}`));row.name=textValue(t.canonicalName||t.scientificName)||row.name;row.chineseName=chineseName(t.vernacularName);row.group=bioGroup(t,layer!);if(!row.chineseName){try{const u='https://api.inaturalist.org/v1/taxa?'+new URLSearchParams({q:row.name,locale:'zh-CN',per_page:'5'});const response=await fetch(u,{signal:AbortSignal.timeout(4000),cf:{cacheEverything:true,cacheTtl:86400}});if(response.ok){const names=await response.json() as any;const exact=(names.results||[]).find((n:any)=>n.is_active===true&&String(n.name).toLowerCase()===row.name.toLowerCase());row.chineseName=chineseName(exact?.preferred_common_name);}}catch{/* A missing optional translation must not hide counts. */}}}catch{partial=true;}}}));
  const data:AtlasStats={rows,totalRecords:result.count,offset,hasMore:facets.length>PAGE,fetchedAt:new Date().toISOString(),partial};
  return Response.json(data,{headers:{'Cache-Control':partial?'private, max-age=30':'private, max-age=600'}});
 }catch{return Response.json({error:'统计来源暂不可用，请重试'},{status:502});}
}
