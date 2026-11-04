import {normalizeTaxonomy,bioGroup} from '../taxonomy';
import {animalGroups,CLIMATE_SERVICE,LAND_COG,MINERAL_SERVICE,geographicTile,splitBounds,mineralGroups,mineralNames,type AtlasRecord,type AtlasRecords} from '../atlas';
const jsonError=(message:string,status=400)=>Response.json({error:message},{status,headers:{'Cache-Control':'no-store'}});
const upstreamOptions=(ttl:number):RequestInit&{cf:Record<string,unknown>}=>({signal:AbortSignal.timeout(25000),cf:{cacheEverything:true,cacheTtlByStatus:{'200-299':ttl,'404':60,'400-403':0,'500-599':0}}});
async function dataJson(url:URL,ttl=600,timeout=25000){const r=await fetch(url,{...upstreamOptions(ttl),signal:AbortSignal.timeout(timeout)});if(!r.ok)throw Error('Atlas upstream unavailable');const data=await r.json() as any;if(data.error)throw Error('Atlas upstream error');return data;}
export function atlasRange(value:string|null){const m=value?.match(/^bytes=(\d+)-(\d+)$/);if(!m)return null;const start=Number(m[1]),end=Number(m[2]);return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&end>=start&&end-start<2097152&&end<84766175540?{start,end}:null;}
export async function atlasData(request:Request,ctx:ExecutionContext){
 const url=new URL(request.url),path=url.pathname;
 if(path==='/api/globe/atlas/landform/data'){
  const range=atlasRange(request.headers.get('Range'));if(!range)return jsonError('需要有效的数据分块范围');
  // Store each byte range under its own key as a 200 response; authenticate before lookup.
  const cacheKey=new Request(url.origin+path+'?block='+range.start+'-'+range.end),cache=caches.default;
  let body=await cache.match(cacheKey);
  if(!body){const upstream=await fetch(LAND_COG,{headers:{Range:`bytes=${range.start}-${range.end}`},signal:AbortSignal.timeout(25000)});
   if(upstream.status!==206||upstream.headers.get('Content-Range')!==`bytes ${range.start}-${range.end}/84766175540`){await upstream.body?.cancel();return jsonError('地貌分块暂不可用',502);}
   const bytes=await upstream.arrayBuffer();if(bytes.byteLength!==range.end-range.start+1)return jsonError('地貌分块不完整',502);
   body=new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'public, max-age=2592000'}});ctx.waitUntil(cache.put(cacheKey,body.clone()));
  }
  return new Response(body.body,{status:206,headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes ${range.start}-${range.end}/84766175540`,'Content-Length':String(range.end-range.start+1),'Accept-Ranges':'bytes','Cache-Control':'private, max-age=604800'}});
 }
 const climate=path.match(/^\/api\/globe\/atlas\/climate\/(\d+)\/(\d+)\/(\d+)$/);
 if(climate){const [z,x,y]=climate.slice(1).map(Number),resolution=.00833330000000387*2**(7-z);if(z>7||x>=Math.ceil(360/(256*resolution))||y>=Math.ceil(180/(256*resolution)))return jsonError('气候瓦片无效');
  const r=await fetch(`${CLIMATE_SERVICE}/tile/${z}/${y}/${x}?sliceId=12`,upstreamOptions(2592000));if(!r.ok){await r.body?.cancel();return jsonError('气候数据暂不可用',502);}const bytes=await r.arrayBuffer();if(bytes.byteLength>1048576||new TextDecoder().decode(bytes.slice(0,6))!=='Lerc2 ')return jsonError('气候数据格式异常',502);
  return new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'private, max-age=604800'}});
 }
 const tile=path.match(/^\/api\/globe\/atlas\/(minerals|plants|animals)\/(\d+)\/(\d+)\/(\d+)\.png$/);
 if(!tile)return jsonError('图谱路径无效',404);
 const [,layer,zs,xs,ys]=tile,z=Number(zs),x=Number(xs),y=Number(ys),bounds=geographicTile(z,x,y);if(!bounds||z>12)return jsonError('瓦片坐标无效');
 let upstream:URL;
 if(layer==='minerals'){
  upstream=new URL('https://mrdata.usgs.gov/services/mrds');upstream.search=new URLSearchParams({service:'WMS',version:'1.1.1',request:'GetMap',layers:'mrds',styles:'',srs:'EPSG:4326',bbox:[bounds.west,bounds.south,bounds.east,bounds.north].join(','),width:'256',height:'256',format:'image/png',transparent:'true'}).toString();
 }else{
  const taxon=layer==='plants'?6:Number(url.searchParams.get('taxon')||1);if(layer==='animals'&&!animalGroups.some(g=>g.key===taxon))return jsonError('动物分类无效');
  upstream=new URL(`https://api.gbif.org/v2/map/occurrence/density/${z}/${x}/${y}@1x.png`);upstream.search=new URLSearchParams({srs:'EPSG:4326',taxonKey:String(taxon),style:layer==='plants'?'greenHeat.point':'orangeHeat.point'}).toString();
 }
 const r=await fetch(upstream,upstreamOptions(layer==='minerals'?604800:21600));if(!r.ok||!r.headers.get('Content-Type')?.includes('image/png')){await r.body?.cancel();return jsonError('图谱瓦片暂不可用',502);}
 return new Response(r.body,{headers:{'Content-Type':'image/png','Cache-Control':'private, max-age=21600','X-Content-Type-Options':'nosniff'}});
}
const clean=(v:unknown,max=200)=>typeof v==='string'?v.slice(0,max):'';
export function mineralRecord(f:any):AtlasRecord|null{const a=f.attributes,g=f.geometry;if(!a||!g||!Number.isFinite(g.x)||!Number.isFinite(g.y)||Math.abs(g.y)>90||Math.abs(g.x)>180)return null;const id=clean(a.DEP_ID,12);if(!/^\d+$/.test(id))return null;const codes=clean(a.CODE_LIST).split(/[,;\s]+/).filter(Boolean);return {id,layer:'minerals',lat:g.y,lon:g.x,name:clean(a.SITE_NAME)||'未命名矿点',kind:codes[0]||'mineral',detail:codes.map(c=>mineralNames[c]||c).join(' · ')||'矿种未注明',quality:clean(a.Grade,8),url:`https://mrdata.usgs.gov/mrds/show-mrds.php?dep_id=${id}`};}
export function occurrenceRecord(r:any,layer:'plants'|'animals'):AtlasRecord|null{
 r=normalizeTaxonomy(r);
 if(!Number.isSafeInteger(r.key)||!Number.isFinite(r.decimalLatitude)||!Number.isFinite(r.decimalLongitude)||Math.abs(r.decimalLatitude)>90||Math.abs(r.decimalLongitude)>180||r.occurrenceStatus==='ABSENT')return null;
 const basis:Record<string,string>={HUMAN_OBSERVATION:'人工观测',MACHINE_OBSERVATION:'设备观测',PRESERVED_SPECIMEN:'保存标本',MATERIAL_SAMPLE:'材料样本',FOSSIL_SPECIMEN:'化石标本',LIVING_SPECIMEN:'活体标本',OCCURRENCE:'出现记录',OBSERVATION:'观测'};
 return {id:String(r.key),layer,group:bioGroup(r,layer),speciesKey:r.speciesKey,name:clean(r.vernacularName)||clean(r.species)||clean(r.scientificName)||'未定名生物',scientificName:clean(r.scientificName),lat:r.decimalLatitude,lon:r.decimalLongitude,kind:clean(r.class)||layer,detail:[clean(r.family),basis[r.basisOfRecord]||'出现记录'].filter(Boolean).join(' · '),date:clean(r.eventDate,32),uncertainty:typeof r.coordinateUncertaintyInMeters==='number'&&r.coordinateUncertaintyInMeters>=0?r.coordinateUncertaintyInMeters:undefined,generalized:!!(r.dataGeneralizations||r.informationWithheld),publisher:clean(r.datasetName)||clean(r.institutionCode)||'原始发布者见 GBIF',license:clean(r.license,120).includes('/by-nc/')?'CC BY-NC 4.0':clean(r.license,120).includes('/by/')?'CC BY 4.0':clean(r.license,120).includes('/zero/')?'CC0':'见原始记录',url:`https://www.gbif.org/occurrence/${r.key}`};
}
export async function atlasRecords(request:Request){
 const p=new URL(request.url).searchParams,layer=p.get('layer');if(layer!=='minerals'&&layer!=='plants'&&layer!=='animals')return jsonError('记录图层无效');
 const names=['west','south','east','north'];if(names.some(n=>!p.get(n)?.trim()))return jsonError('范围无效');const [w,s,e,n]=names.map(k=>Number(p.get(k))),parts=splitBounds(w,s,e,n);if(!parts.length)return jsonError('范围无效');
 const filter=p.get('filter')||'all',taxon=layer==='plants'?6:Number(p.get('taxon')||1);if(layer==='minerals'&&!mineralGroups.some(g=>g.key===filter)||layer==='animals'&&!animalGroups.some(g=>g.key===taxon))return jsonError('分类无效');
 const results=await Promise.all(parts.map(async b=>{
  if(layer==='minerals'){
   const u=new URL(MINERAL_SERVICE+'/query');u.search=new URLSearchParams({f:'json',where:filter==='all'?'1=1':`(CODE_LIST = '${filter}' OR CODE_LIST LIKE '${filter} %' OR CODE_LIST LIKE '% ${filter}' OR CODE_LIST LIKE '% ${filter} %')`,geometry:b.join(','),geometryType:'esriGeometryEnvelope',inSR:'4326',outSR:'4326',spatialRel:'esriSpatialRelIntersects',outFields:'DEP_ID,SITE_NAME,CODE_LIST,Grade',returnGeometry:'true',orderByFields:'OBJECTID',resultRecordCount:'180'}).toString();const d=await dataJson(u,604800);return {records:(d.features||[]).map(mineralRecord).filter(Boolean) as AtlasRecord[],total:null,truncated:!!d.exceededTransferLimit};
  }
  const u=new URL('https://api.gbif.org/v1/occurrence/search');u.search=new URLSearchParams({decimalLongitude:`${b[0]},${b[2]}`,decimalLatitude:`${b[1]},${b[3]}`,taxonKey:String(taxon),hasCoordinate:'true',hasGeospatialIssue:'false',occurrenceStatus:'PRESENT',limit:'20'}).toString();const pages=await Promise.allSettled([0,20,40].map(offset=>{const page=new URL(u);page.searchParams.set('offset',String(offset));return dataJson(page,600,8000);}));const loaded=pages.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);if(!loaded.length)throw Error('Occurrence source unavailable');return {records:loaded.flatMap(d=>(d.results||[]).map((r:any)=>occurrenceRecord(r,layer)).filter(Boolean)) as AtlasRecord[],total:typeof loaded[0].count==='number'?loaded[0].count:null,truncated:pages.some(r=>r.status==='rejected')||!loaded.some(d=>d.endOfRecords)};
 }));
 const records=[...new Map(results.flatMap(r=>r.records).map(r=>[r.id,r])).values()];const data:AtlasRecords={records,total:results.every(r=>typeof r.total==='number')?results.reduce((a,r)=>a+(r.total||0),0):null,truncated:results.some(r=>r.truncated),fetchedAt:new Date().toISOString()};
 return Response.json(data,{headers:{'Cache-Control':'private, max-age=600'}});
}
