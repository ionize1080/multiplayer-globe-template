import {normalizeTaxonomy} from '../taxonomy';
import {chineseName,photoLicense,safeHttps,textValue as txt,type SpeciesDetails} from '../species';
async function json(url:string){const r=await fetch(url,{signal:AbortSignal.timeout(9000),headers:{Accept:'application/json'},cf:{cacheEverything:true,cacheTtlByStatus:{'200-299':86400,'404':60,'500-599':0}}});if(!r.ok)throw Error('Species source unavailable');return await r.json() as any;}
export async function speciesDetails(request:Request){
 const id=new URL(request.url).searchParams.get('occurrence');
 if(!id||!/^\d{1,16}$/.test(id)||!Number.isSafeInteger(Number(id))||Number(id)<=0)return Response.json({error:'观测记录编号无效'},{status:400});
 let r:any;try{r=await json('https://api.gbif.org/v1/occurrence/'+id);}catch{return Response.json({error:'物种资料暂不可用，请重试'},{status:502});}
 r=normalizeTaxonomy(r);
 if(![1,6].includes(r.kingdomKey))return Response.json({error:'此记录不属于动植物图层'},{status:404});
 const d:SpeciesDetails={chineseName:chineseName(r.vernacularName),nameSource:'',scientificName:txt(r.scientificName),taxonomy:[],facts:[],photos:[],links:[{label:'GBIF 观测记录',url:'https://www.gbif.org/occurrence/'+id}],partial:false};
 if(d.chineseName)d.nameSource='GBIF 原始观测记录';
 const key=Number(r.speciesKey||r.acceptedTaxonKey||r.taxonKey);
 let taxon:any={};
 if(Number.isSafeInteger(key)&&key>0){
  const results=await Promise.allSettled([json(`https://api.gbif.org/v1/species/${key}`),json(`https://api.gbif.org/v1/species/${key}/vernacularNames?limit=1000`)]);
  if(results[0].status==='fulfilled')taxon=results[0].value;else d.partial=true;
  if(results[1].status==='fulfilled'){
   const names=results[1].value.results||[];
   const n=names.find((n:any)=>/^(zh|zho|chi)(-|$)/i.test(n.language||'')&&chineseName(n.vernacularName));
   if(!d.chineseName&&n){d.chineseName=chineseName(n.vernacularName);d.nameSource='GBIF · '+(txt(n.source)||'中文俗名');}
  }else d.partial=true;
  d.links.push({label:'GBIF 物种档案',url:`https://www.gbif.org/species/${key}`});
 }
 for(const [field,label] of [['kingdom','界'],['phylum','门'],['class','纲'],['order','目'],['family','科'],['genus','属']]){const value=txt(r[field]||taxon[field]);if(value)d.taxonomy.push({label,value});}
 for(const [field,label] of [['recordedBy','记录者'],['identifiedBy','鉴定者'],['habitat','生境'],['locality','记录地点'],['country','国家 / 地区'],['stateProvince','省 / 州'],['lifeStage','生命阶段'],['sex','性别'],['establishmentMeans','建立方式'],['individualCount','记录个体数']]){const value=typeof r[field]==='number'?String(r[field]):txt(r[field]);if(value)d.facts.push({label,value});}
 for(const m of (Array.isArray(r.media)?r.media:[]).slice(0,20)){
  const url=safeHttps(m.identifier),license=photoLicense(m.license);
  if(url&&license&&(m.type==='StillImage'||String(m.format).startsWith('image/')))d.photos.push({url,license,credit:txt(m.creator||m.rightsHolder)||'作者见原始记录',source:safeHttps(m.references)||`https://www.gbif.org/occurrence/${id}`,reference:false});
  if(d.photos.length===3)break;
 }
 const name=txt(taxon.canonicalName||r.species);
 if(name&&(!d.chineseName||!d.photos.length))try{
  const data=await json('https://api.inaturalist.org/v1/taxa?'+new URLSearchParams({q:name,locale:'zh-CN',per_page:'10'}));
  // Never use the first fuzzy result or a subspecies photo for a different taxon.
  const t=(data.results||[]).find((t:any)=>t.is_active===true&&txt(t.name).toLowerCase()===name.toLowerCase()&&Number.isSafeInteger(t.id));
  if(t){const source=`https://www.inaturalist.org/taxa/${t.id}`;d.links.push({label:'iNaturalist 物种档案',url:source});
   if(!d.chineseName){d.chineseName=chineseName(t.preferred_common_name);if(d.chineseName)d.nameSource='iNaturalist · 中文名称';}
   const p=t.default_photo,license=photoLicense(p?.license_code),url=safeHttps(p?.medium_url);
   if(!d.photos.length&&url&&license)d.photos.push({url,license,credit:txt(p.attribution)||'作者见来源',source,reference:true});
  }
 }catch{d.partial=true;}
 return Response.json(d,{headers:{'Cache-Control':d.partial?'private, max-age=60':'private, max-age=86400'}});
}
