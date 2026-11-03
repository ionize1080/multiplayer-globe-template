import {useEffect,useRef,useState,type RefObject} from 'react';
import type {Viewer,ImageryLayer} from 'cesium';
import {atlasMeta,type AtlasLayer,type AtlasRecords} from '../atlas';
import type {RasterKind,RasterTask} from './atlas-raster';
type RasterReply={bitmap?:ImageBitmap;value?:number};
export function useAtlas(viewer:RefObject<Viewer>,ready:boolean,enabled:boolean,layer:AtlasLayer,taxon:number,filter:string,opacity:number,picked:{lat:number;lon:number}|null,onExpired:()=>void){
 const [note,setNote]=useState(''),[records,setRecords]=useState<AtlasRecords|null>(null),[recordNote,setRecordNote]=useState(''),[pointClass,setPointClass]=useState<number|null>(null),[pointNote,setPointNote]=useState('');
 const imagery=useRef<ImageryLayer|null>(null),task=useRef<((t:Omit<RasterTask,'id'>)=>Promise<RasterReply>)|null>(null),expired=useRef(onExpired),alpha=useRef(opacity);expired.current=onExpired;alpha.current=opacity;
 const cache=useRef(new Map<string,{at:number;data:AtlasRecords}>());
 useEffect(()=>{const v=viewer.current;if(!enabled||!ready||!v)return;let stopped=false,worker:Worker|undefined;const pending=new Map<number,{resolve:(v:RasterReply)=>void;reject:(e:Error)=>void}>();let id=0;setNote('正在加载图谱…');
  void import('cesium').then(C=>{if(stopped||v.isDestroyed())return;const scheme=new C.GeographicTilingScheme();let provider:import('cesium').UrlTemplateImageryProvider;
   if(layer==='climate'||layer==='landform'){
    worker=new Worker('/dist/atlas-worker.js',{type:'module'});const call=(t:Omit<RasterTask,'id'>)=>new Promise<RasterReply>((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});worker!.postMessage({...t,id:n});});task.current=call;
    worker.onmessage=(e:MessageEvent<{id:number;error?:string}&RasterReply>)=>{const entry=pending.get(e.data.id);if(!entry){e.data.bitmap?.close();return;}pending.delete(e.data.id);if(e.data.error){if(e.data.error==='SESSION_EXPIRED')expired.current();entry.reject(Error(e.data.error));}else entry.resolve(e.data);};
    worker.onerror=()=>{setNote('图谱解码失败，请切换图层重试');for(const p of pending.values())p.reject(Error('图谱解码失败'));pending.clear();};
    provider=new C.UrlTemplateImageryProvider({url:'/api/globe/atlas/'+layer+'/{z}/{x}/{y}',tilingScheme:scheme,maximumLevel:layer==='climate'?9:12,enablePickFeatures:false,credit:new C.Credit(atlasMeta[layer].source,true)});
    provider.requestImage=(x,y,z)=>pending.size>=12?undefined:call({kind:layer as RasterKind,x,y,z}).then(r=>{if(stopped){r.bitmap?.close();return document.createElement('canvas');}const canvas=document.createElement('canvas');canvas.width=canvas.height=256;canvas.getContext('2d')!.drawImage(r.bitmap!,0,0);r.bitmap!.close();setNote('');return canvas;}).catch(e=>{if(!stopped)setNote('部分图谱数据未加载，请稍后切换重试');throw e;});
   }else{
    if(layer==='minerals'&&filter!=='all'){setNote('矿种筛选已启用，放大后显示符合条件的矿点');return;}
    provider=new C.UrlTemplateImageryProvider({url:`/api/globe/atlas/${layer}/{z}/{x}/{y}.png?taxon=${taxon}`,tilingScheme:scheme,tileWidth:layer==='minerals'?256:512,tileHeight:layer==='minerals'?256:512,maximumLevel:12,enablePickFeatures:false,credit:new C.Credit(atlasMeta[layer].source,true)});setNote('');
   }
   provider.errorEvent.addEventListener(()=>{if(!stopped)setNote('部分图谱数据未加载；空白不表示没有记录');});const added=v.imageryLayers.addImageryProvider(provider);imagery.current=added;added.alpha=alpha.current;v.scene.requestRender();
  }).catch(()=>{if(!stopped)setNote('图谱启动失败，请重试');});
  return()=>{stopped=true;worker?.terminate();task.current=null;for(const p of pending.values())p.reject(Error('图层已切换'));pending.clear();if(imagery.current&&!v.isDestroyed()){v.imageryLayers.remove(imagery.current);imagery.current=null;v.scene.requestRender();}};
 },[ready,enabled,layer,taxon,filter]);
 useEffect(()=>{if(imagery.current)imagery.current.alpha=opacity;viewer.current?.scene.requestRender();},[opacity]);
 useEffect(()=>{
  setPointClass(null);setPointNote('');if(!enabled||!ready||!picked||layer!=='climate'&&layer!=='landform')return;let stopped=false;setPointNote('正在读取原始分类…');
  const timer=setTimeout(()=>{const call=task.current;if(!call){setPointNote('图层尚未就绪，请重新选点');return;}void call({kind:layer,lat:picked.lat,lon:picked.lon}).then(r=>{if(!stopped){setPointClass(r.value??0);setPointNote('');}}).catch(()=>{if(!stopped)setPointNote('该位置分类暂不可用，请重试');});},450);return()=>{stopped=true;clearTimeout(timer);};
 },[enabled,ready,layer,picked]);
 useEffect(()=>{
  setRecords(null);setRecordNote('');const v=viewer.current;if(!ready||!enabled||!v||layer==='climate'||layer==='landform')return;let stopped=false,abort:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined,sequence=0,remove:(()=>void)|undefined;
  void import('cesium').then(C=>{if(stopped)return;const update=()=>{const bounds=v.camera.computeViewRectangle();if(!bounds)return;const rad=C.Math.toDegrees,w=rad(bounds.west),e=rad(bounds.east),s=rad(bounds.south),n=rad(bounds.north),span=(e-w+360)%360||360;const current=++sequence;abort?.abort();if(span>35||n-s>25){setRecords(null);setRecordNote('放大地图查看具体'+(layer==='minerals'?'矿点':'物种观测')+(layer==='minerals'&&filter!=='all'?'':'；当前显示全局记录分布'));return;}
    const params=new URLSearchParams({layer,taxon:String(taxon),filter,west:(Math.floor(w*1000)/1000).toFixed(3),east:(Math.ceil(e*1000)/1000).toFixed(3),south:(Math.max(-90,Math.floor(s*1000)/1000)).toFixed(3),north:(Math.min(90,Math.ceil(n*1000)/1000)).toFixed(3)}),key=params.toString(),hit=cache.current.get(key);if(hit&&Date.now()-hit.at<600000){setRecords(hit.data);setRecordNote('');return;}
    setRecords(null);setRecordNote('正在查询视野内的公开记录…');const controller=new AbortController();abort=controller;
    void fetch('/api/globe/atlas/records?'+key,{signal:controller.signal}).then(async r=>{if(r.status===401){expired.current();throw Error();}if(!r.ok)throw Error();return await r.json() as AtlasRecords;}).then(data=>{if(stopped||current!==sequence)return;cache.current.set(key,{at:Date.now(),data});while(cache.current.size>64)cache.current.delete(cache.current.keys().next().value!);setRecords(data);setRecordNote(data.records.length?'':'当前视野内暂无已收录记录，可移动或缩小地图。');}).catch(()=>{if(!stopped&&!controller.signal.aborted&&current===sequence)setRecordNote('记录查询暂不可用，请移动地图重试');});
   };const schedule=()=>{clearTimeout(timer);timer=setTimeout(update,650);};remove=v.camera.moveEnd.addEventListener(schedule);schedule();});
  return()=>{stopped=true;abort?.abort();clearTimeout(timer);remove?.();};
 },[ready,enabled,layer,taxon,filter]);
 return {note,records,recordNote,pointClass,pointNote,imagery};
}
