import {useEffect,useRef,useState,type RefObject} from 'react';
import type {Viewer,ImageryLayer} from 'cesium';
import {satelliteView,type SatelliteManifest,type SatelliteMode} from '../satellite';
import {visibleRectangle} from './visible-rectangle';
type State={status:'idle'|'zoom'|'loading'|'empty'|'ready'|'error';message:string;scene?:SatelliteManifest};
export function useSatellite(viewer:RefObject<Viewer>,ready:boolean,enabled:boolean,mode:SatelliteMode,onExpired:()=>void,restack:()=>void){
 const layer=useRef<ImageryLayer|null>(null),expired=useRef(onExpired),stack=useRef(restack);expired.current=onExpired;stack.current=restack;
 const [state,setState]=useState<State>({status:'idle',message:''}),[revision,refresh]=useState(0);
 const cache=useRef(new Map<string,{scene:SatelliteManifest|null;url?:string;at:number}>());
 useEffect(()=>()=>{for(const item of cache.current.values())if(item.url)URL.revokeObjectURL(item.url);cache.current.clear();},[]);
 useEffect(()=>{const v=viewer.current;if(!ready||!v||!enabled)return;let stopped=false,sequence=0,timer:ReturnType<typeof setTimeout>,abort:AbortController|undefined,last=0;
 const clear=()=>{if(v.isDestroyed()){layer.current=null;return;}if(layer.current&&v.imageryLayers.contains(layer.current))v.imageryLayers.remove(layer.current);layer.current=null;v.scene.requestRender();};
 const update=async(id:number)=>{const C=await import('cesium');if(stopped||id!==sequence||v.isDestroyed())return;const r=visibleRectangle(v,C),view=r?satelliteView({west:C.Math.toDegrees(r.west),east:C.Math.toDegrees(r.east),south:C.Math.toDegrees(r.south),north:C.Math.toDegrees(r.north)}):null;
  if(!view){clear();setState({status:'zoom',message:'放大至城市或区域查看近期卫星影像（视野宽、高不超过 160 km）。跨日期变更线时请移至一侧。'});return;}
  abort?.abort();abort=new AbortController();const signal=abort.signal,key=mode+':'+view.key;last=Date.now();setState({status:'loading',message:'正在查找并加载近期卫星影像…'});
  try{let hit=cache.current.get(key);if(hit&&Date.now()-hit.at>15*60000){if(hit.url)URL.revokeObjectURL(hit.url);cache.current.delete(key);hit=undefined;}
   if(!hit){const q=new URLSearchParams({...Object.fromEntries(Object.entries(view.bounds).map(([k,v])=>[k,String(v)])),mode});const response=await fetch('/api/globe/satellite/scene?'+q,{signal});if(response.status===401){expired.current();return;}const data=await response.json();if(!response.ok)throw Error(data.error||'卫星目录暂不可用');const scene=data.scene as SatelliteManifest|null;
    if(scene){const image=await fetch(scene.imageUrl,{signal});if(image.status===401){expired.current();return;}if(!image.ok){const d=await image.json().catch(()=>({}));throw Error(d.error||'卫星影像加载失败');}const blob=await image.blob();if(signal.aborted)return;hit={scene,url:URL.createObjectURL(blob),at:Date.now()};}else hit={scene:null,at:Date.now()};
    if(stopped||id!==sequence){if(hit.url)URL.revokeObjectURL(hit.url);return;}cache.current.set(key,hit);while(cache.current.size>12){const oldest=cache.current.keys().next().value!;const item=cache.current.get(oldest);if(item?.url)URL.revokeObjectURL(item.url);cache.current.delete(oldest);}
   }
   if(stopped||id!==sequence)return;
   if(!hit.scene||!hit.url){clear();setState({status:'empty',message:'视野中心近 30 天暂无 Sentinel‑2 影像。当前显示参考底图，可移动到附近陆地查看。'});return;}
   const s=hit.scene,b=s.bounds,provider=await C.SingleTileImageryProvider.fromUrl(hit.url,{rectangle:C.Rectangle.fromDegrees(b.west,b.south,b.east,b.north),credit:new C.Credit('Contains modified Copernicus Sentinel data · CDSE / Sentinel Hub',true)});
   if(stopped||id!==sequence)return;clear();layer.current=v.imageryLayers.addImageryProvider(provider,Math.min(1,v.imageryLayers.length));stack.current();v.scene.requestRender();setState({status:'ready',message:'',scene:s});
  }catch(error){if(!signal.aborted&&!stopped&&id===sequence){clear();setState({status:'error',message:error instanceof Error?error.message:'卫星影像加载失败，请重试'});}}
 };
 const schedule=()=>{const id=++sequence;abort?.abort();clearTimeout(timer);timer=setTimeout(()=>void update(id).catch(()=>{if(!stopped&&id===sequence)setState({status:'error',message:'卫星图层暂不可用'});}),Math.max(1200,5000-(Date.now()-last)));};
 const start=v.camera.moveStart.addEventListener(()=>{sequence++;abort?.abort();clearTimeout(timer);if(layer.current)layer.current.show=false;setState({status:'loading',message:'移动结束后加载当前范围的近期影像…'});});
 const end=v.camera.moveEnd.addEventListener(schedule),resize=new ResizeObserver(schedule);resize.observe(v.container);schedule();
 return()=>{stopped=true;sequence++;clearTimeout(timer);abort?.abort();start();end();resize.disconnect();clear();};
 },[ready,enabled,mode,revision]);
 return {state,layer,refresh:()=>refresh(n=>n+1)};
}
