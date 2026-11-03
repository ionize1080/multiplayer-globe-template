import React,{useEffect,useRef,useState} from 'react';
import type {LocationDetails} from '../location-details';
export function PointLocation({lat,lon,onExpired}:{lat:number;lon:number;onExpired:()=>void}){
 const cache=useRef(new Map<string,{data:LocationDetails;at:number}>()),expired=useRef(onExpired);expired.current=onExpired;
 const key=`${lat.toFixed(5)},${lon.toFixed(5)}`;
 const [result,setResult]=useState<{key:string;data:LocationDetails}|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{setError('');const hit=cache.current.get(key);if(hit&&Date.now()-hit.at<86400000){setResult({key,data:hit.data});return;}const abort=new AbortController();
 const timer=setTimeout(()=>{void(async()=>{try{const r=await fetch(`/api/globe/location?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`,{signal:abort.signal});if(r.status===401){expired.current();return;}if(!r.ok)throw Error(r.status===429?'查询较频繁，请稍后重试':'所在地加载失败，请重试');const data=await r.json() as LocationDetails;if(abort.signal.aborted)return;cache.current.set(key,{data,at:Date.now()});while(cache.current.size>64)cache.current.delete(cache.current.keys().next().value!);setResult({key,data});}catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:'所在地加载失败');}})();},350);
 return()=>{clearTimeout(timer);abort.abort();};},[key,attempt]);
 const data=result?.key===key?result.data:null;
 return <section className="point-location" aria-label="所在地"><h3>所在地</h3>{data?.parts.length?<><dl>{data.parts.map(p=><React.Fragment key={p.label}><dt>{p.label}</dt><dd>{p.value}</dd></React.Fragment>)}</dl><p>附近已标注地点{data.distanceMeters!==null?` · 距选点约 ${data.distanceMeters<1000?data.distanceMeters+' m':(data.distanceMeters/1000).toFixed(1)+' km'}`:''}，仅供定位参考。</p></>:<p role="status">{error||(!data?'正在识别所在地…':'附近暂无可用地名或地址；海洋、极地及偏远地区可能缺少标注，请以选点坐标定位。')}</p>}{error&&<button type="button" onClick={()=>setAttempt(n=>n+1)}>重试所在地</button>}<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Photon / © OpenStreetMap contributors ↗</a></section>;
}
