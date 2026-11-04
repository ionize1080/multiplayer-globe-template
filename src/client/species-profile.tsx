import React,{useEffect,useState} from 'react';
import type {AtlasRecord} from '../atlas';
import {speciesPreviewUrl,type SpeciesDetails} from '../species';
import {groupNames} from '../taxonomy';
import {AtlasIcon,recordIcon} from './atlas-icons';
export function SpeciesProfile({record,onExpired}:{record:AtlasRecord;onExpired:()=>void}){
 const [data,setData]=useState<SpeciesDetails|null>(null),[error,setError]=useState(''),[revision,retry]=useState(0),[failed,setFailed]=useState<string[]>([]),[original,setOriginal]=useState<string[]>([]);
 useEffect(()=>{const abort=new AbortController();setData(null);setError('');setFailed([]);setOriginal([]);
  void (async()=>{try{const r=await fetch('/api/globe/atlas/species?occurrence='+encodeURIComponent(record.id),{signal:abort.signal});if(r.status===401){onExpired();return;}const body=await r.json();if(!r.ok)throw Error(body.error||'物种资料暂不可用');if(!abort.signal.aborted)setData(body);}catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:'物种资料暂不可用');}})();
  return()=>abort.abort();
 },[record.id,revision]);
 const photos=data?.photos.filter(p=>!failed.includes(p.url))||[];
 return <div className="species-profile"><div className="species-category"><AtlasIcon name={recordIcon(record.kind,record.layer,record.group)}/>{record.group?groupNames[record.group]:'物种记录'}</div><h3>{data?.chineseName||record.name}</h3><em>{data?.scientificName||record.scientificName}</em>
  {error?<p role="alert">{error} <button onClick={()=>retry(n=>n+1)}>重试资料</button></p>:!data?<><p role="status">正在加载物种资料…</p><div className="photo-skeleton"/></>:<>
   {photos.length?photos.map((photo,i)=>{const src=original.includes(photo.url)?photo.url:speciesPreviewUrl(photo.url);return <figure key={photo.url}><a href={photo.source} target="_blank" rel="noreferrer"><img src={src} alt={(data.chineseName||data.scientificName)+(photo.reference?' · 同物种参考图':' · 本次观测照片')} loading={i===0?'eager':'lazy'} decoding="async" referrerPolicy="no-referrer" onError={()=>src!==photo.url?setOriginal(a=>[...a,photo.url]):setFailed(a=>[...a,photo.url])}/></a><figcaption><strong>{photo.reference?'同物种参考图 · 非本次观测':'本次记录照片'}</strong><br/>{photo.credit} · {photo.license} · <a href={photo.source} target="_blank" rel="noreferrer">图片来源 ↗</a></figcaption></figure>;}):<p className="species-empty">暂无可展示的授权照片</p>}
   {data.taxonomy.length>0&&<details><summary>分类信息</summary><dl>{data.taxonomy.map(p=><React.Fragment key={p.label}><dt>{p.label}</dt><dd>{p.value}</dd></React.Fragment>)}</dl></details>}
   {data.facts.length>0&&<details><summary>更多观测资料</summary><dl>{data.facts.map(p=><React.Fragment key={p.label}><dt>{p.label}</dt><dd>{p.value}</dd></React.Fragment>)}</dl></details>}
   <details><summary>名称与数据来源</summary><p>{data.nameSource||'暂无可靠中文名，保留原始名称。'}</p><p>{record.publisher} · {record.license}</p><div className="species-links">{data.links.map(p=><a key={p.url} href={p.url} target="_blank" rel="noreferrer">{p.label} ↗</a>)}</div></details>
   {data.partial&&<p role="status">部分资料暂不可用。<button onClick={()=>retry(n=>n+1)}>重新加载</button></p>}
  </>}
  <dl className="species-observation"><dt>观测日期</dt><dd>{record.date?.slice(0,10)||'未提供'}</dd><dt>记录位置</dt><dd>{record.lat.toFixed(4)}°, {record.lon.toFixed(4)}°</dd><dt>位置误差</dt><dd>{record.uncertainty===undefined?'未提供':record.uncertainty.toLocaleString()+' m'}{record.generalized?' · 已概化':''}</dd></dl><a href={record.url} target="_blank" rel="noreferrer">原始观测记录 ↗</a>
 </div>;
}
