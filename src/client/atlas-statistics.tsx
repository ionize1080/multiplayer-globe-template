import React,{useEffect,useRef,useState,type RefObject} from 'react';
import type {Viewer} from 'cesium';
import type {AtlasRecord} from '../atlas';
import type {AtlasBounds,AtlasStats,RecordPage,SpeciesRow} from '../atlas-stats';
import {groupNames} from '../taxonomy';
import {AtlasIcon} from './atlas-icons';
import {visibleRectangle} from './visible-rectangle';
export function AtlasStatistics({viewer,initialLayer,onPick,onExpired,onClose}:{viewer:RefObject<Viewer>;initialLayer:'plants'|'animals';onPick:(r:AtlasRecord)=>void;onExpired:()=>void;onClose:()=>void}){
 const [bounds,setBounds]=useState<AtlasBounds|null>(null),[layer,setLayer]=useState(initialLayer),[offset,setOffset]=useState(0),[species,setSpecies]=useState<SpeciesRow|null>(null),[recordOffset,setRecordOffset]=useState(0),[stats,setStats]=useState<AtlasStats|null>(null),[records,setRecords]=useState<RecordPage|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,retry]=useState(0);
 const cache=useRef(new Map<string,{at:number;data:AtlasStats|RecordPage}>()),body=useRef<HTMLDivElement>(null),active=useRef(true),expired=useRef(onExpired);expired.current=onExpired;
 const snapshot=async()=>{const v=viewer.current;if(!v||v.isDestroyed())return;const C=await import('cesium');if(!active.current||v.isDestroyed())return;const r=visibleRectangle(v,C);if(!r){setError('当前视野不可用，请移动地图后重试');return;}setBounds({west:C.Math.toDegrees(r.west),south:C.Math.toDegrees(r.south),east:C.Math.toDegrees(r.east),north:C.Math.toDegrees(r.north)});setOffset(0);setSpecies(null);setRecordOffset(0);};
 useEffect(()=>{active.current=true;const timer=setTimeout(()=>void snapshot(),300);return()=>{active.current=false;clearTimeout(timer);};},[]);
 useEffect(()=>{body.current?.scrollTo({top:0});},[layer,offset,species,recordOffset]);
 useEffect(()=>{if(!bounds)return;const abort=new AbortController();setLoading(true);setError('');setStats(null);setRecords(null);
  const params=new URLSearchParams({...Object.fromEntries(Object.entries(bounds).map(([k,v])=>[k,String(v)])),layer,offset:String(species?recordOffset:offset)});if(species)params.set('species',String(species.key));const key=params.toString();
  void (async()=>{try{let data:AtlasStats|RecordPage;const hit=cache.current.get(key);if(hit&&Date.now()-hit.at<600000)data=hit.data;else{const r=await fetch('/api/globe/atlas/stats?'+key,{signal:abort.signal});if(r.status===401){expired.current();return;}data=await r.json();if(!r.ok)throw Error((data as {error?:string}).error||'统计暂不可用');if(abort.signal.aborted)return;cache.current.set(key,{at:Date.now(),data});while(cache.current.size>16)cache.current.delete(cache.current.keys().next().value!);}
   if(abort.signal.aborted)return;if(species)setRecords(data as RecordPage);else setStats(data as AtlasStats);
  }catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:'统计暂不可用');}finally{if(!abort.signal.aborted)setLoading(false);}})();
  return()=>abort.abort();
 },[bounds,layer,offset,species,recordOffset,revision]);
 const currentOffset=species?recordOffset:offset,hasMore=species?records?.hasMore:stats?.hasMore;
 const changePage=(step:number)=>species?setRecordOffset(n=>Math.max(0,n+step*20)):setOffset(n=>Math.max(0,n+step*20));
 const retryLoad=()=>{cache.current.clear();retry(n=>n+1);};
 return <section className="atlas-statistics" aria-label="视野物种统计"><header><div><span className="atlas-eyebrow">BIODIVERSITY INDEX</span><h2>视野物种名录</h2></div><button aria-label="关闭物种统计" onClick={onClose}>×</button></header><div className="atlas-statistics-body" ref={body}>
  <p className="stats-intro">从地图上的亮点，认识一片区域的生命。</p><div className="stats-actions"><div role="group" aria-label="统计生物类别">{(['animals','plants'] as const).map(k=><button key={k} aria-pressed={layer===k} onClick={()=>{setLayer(k);setOffset(0);setSpecies(null);setRecordOffset(0);}}>{k==='plants'?'植物':'动物'}</button>)}</div><button onClick={()=>void snapshot()}>更新为当前视野 ↻</button></div>
  {bounds&&<p className="stats-scope">固定范围 · 纬度 {bounds.south.toFixed(2)}° 至 {bounds.north.toFixed(2)}°<br/>经度 {bounds.west.toFixed(2)}° 至 {bounds.east.toFixed(2)}° {bounds.west>bounds.east?'· 跨日期变更线':''}</p>}
  {species&&<><button className="stats-back" onClick={()=>{setSpecies(null);setRecordOffset(0);}}>← 返回物种名录</button><h3>{species.chineseName||species.name}</h3><p>{species.count.toLocaleString()} 条范围内记录</p></>}
  {loading&&<p role="status" className="stats-loading">正在汇总公开记录…</p>}{error&&<p role="alert">{error} <button onClick={retryLoad}>重试</button></p>}
  {stats&&<><div className="stats-total"><strong>{stats.totalRecords.toLocaleString()}</strong><span>范围内出现记录 · 非生物个体数</span></div><p className="stats-caption">按记录数排序 · {stats.rows.length?`第 ${offset+1}–${offset+stats.rows.length} 项`:'暂无物种'}</p><table><thead><tr><th scope="col">物种 / 大类</th><th scope="col">记录数</th></tr></thead><tbody>{stats.rows.map(row=><tr key={row.key}><td><button className="species-row" onClick={()=>{setSpecies(row);setRecordOffset(0);}}><AtlasIcon name={row.group} size={26}/><span><strong>{row.chineseName||row.name}</strong>{row.chineseName&&<em>{row.name}</em>}<small>{groupNames[row.group]}</small></span></button></td><td>{row.count.toLocaleString()}</td></tr>)}</tbody></table>{!stats.rows.length&&<p>这个范围暂未收录可按物种归类的记录。</p>}{stats.partial&&<p role="status">部分名称暂未加载，记录数仍可查看。<button onClick={retryLoad}>重试名称</button></p>}</>}
  {records&&<><div className="stats-records">{records.records.map(r=><button key={r.id} onClick={()=>onPick(r)}><span>{r.date?.slice(0,10)||'日期未提供'}</span><strong>{r.name}</strong><small>{r.lat.toFixed(4)}°, {r.lon.toFixed(4)}° · {r.publisher}</small><span>查看详情 ↗</span></button>)}</div>{!records.records.length&&<p>本页暂无有效坐标记录。</p>}</>}
  {(stats||records)&&<div className="stats-pages"><button disabled={loading||currentOffset===0} onClick={()=>changePage(-1)}>← 上一页</button><span>第 {currentOffset/20+1} 页</span><button disabled={loading||!hasMore||currentOffset>=10000} onClick={()=>changePage(1)}>下一页 →</button></div>}
  <details className="stats-method"><summary>统计口径与来源</summary><p>统计固定视野内有坐标、没有已标记地理问题的 GBIF 出现记录。未鉴定到种的记录可能计入总数，但不进入物种名录。记录数量不等于个体数量、丰度或完整分布；不同来源也可能重复记录。地图上的图标仅为部分抽样，统计查询独立索引。</p><p>中文名补充自 iNaturalist，以拉丁学名严格匹配，可能存在地区别名。</p><a href="https://www.gbif.org/" target="_blank" rel="noreferrer">GBIF 数据来源 ↗</a></details>
 </div></section>;
}
