import {useEffect,useRef,useState,type RefObject} from 'react';
import type {Viewer,ImageryLayer,SingleTileImageryProvider} from 'cesium';
import {satelliteView,type SatelliteManifest,type SatelliteMode} from '../satellite';
import type {SatelliteInterval} from '../satellite-timeline';
import {visibleRectangle} from './visible-rectangle';
export type SatelliteExperience='quick'|'animation'|'browse';
export type TimelineScene=SatelliteManifest&{targetAt?:string;offsetDays?:number};
type Catalogue={scenes:TimelineScene[];total:number;hasMore:boolean;missing:number;toleranceDays:number;searchedFrom?:string};
type State={status:'idle'|'zoom'|'loading'|'empty'|'ready'|'error';message:string;scene?:TimelineScene};
type Cached={url:string;provider:SingleTileImageryProvider;bytes:number};
export function useSatellite(viewer:RefObject<Viewer>,ready:boolean,enabled:boolean,onExpired:()=>void,restack:()=>void){
 const [experience,setExperience]=useState<SatelliteExperience>('quick'),[mode,setMode]=useState<SatelliteMode>('latest'),[interval,setInterval]=useState<SatelliteInterval>('recent'),[count,setCount]=useState(15),[speed,setSpeed]=useState(1),[month,setMonth]=useState(()=>new Date().toISOString().slice(0,7)),[page,setPage]=useState(0);
 const [state,setState]=useState<State>({status:'idle',message:''}),[catalogue,setCatalogue]=useState<Catalogue|null>(null),[catalogueLoading,setCatalogueLoading]=useState(false),[catalogueError,setCatalogueError]=useState(''),[selected,setSelected]=useState<TimelineScene|null>(null),[index,setIndex]=useState(0),[playing,setPlaying]=useState(false),[loaded,setLoaded]=useState<Set<string>>(new Set()),[revision,refresh]=useState(0),[imageRevision,retryImage]=useState(0);
 const flights=useRef(new Map<string,{controller:AbortController;promise:Promise<Cached>}>());
 const cancelTransfers=(keep?:string)=>{for(const [key,flight] of flights.current)if(key!==keep){flight.controller.abort();flights.current.delete(key);}};
 const [view,setView]=useState<ReturnType<typeof satelliteView>>(null),layer=useRef<ImageryLayer|null>(null),renderLayers=useRef<ImageryLayer[]>([]),cache=useRef(new Map<string,Cached>()),metadata=useRef(new Map<string,{data:Catalogue;at:number}>()),activeKey=useRef(''),expired=useRef(onExpired),stack=useRef(restack),displaySequence=useRef(0);
 expired.current=onExpired;stack.current=restack;
 const clearLayers=()=>{const v=viewer.current;if(v&&!v.isDestroyed()){for(const item of renderLayers.current)if(v.imageryLayers.contains(item))v.imageryLayers.remove(item);v.scene.requestRender();}renderLayers.current=[];layer.current=null;};
 const clearImages=()=>{cancelTransfers();for(const item of cache.current.values())URL.revokeObjectURL(item.url);cache.current.clear();setLoaded(new Set());};
 useEffect(()=>{const v=viewer.current;if(!ready||!v||!enabled)return;let stopped=false,timer:ReturnType<typeof setTimeout>;
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>void import('cesium').then(C=>{if(stopped||v.isDestroyed())return;const r=visibleRectangle(v,C),next=r?satelliteView({west:C.Math.toDegrees(r.west),east:C.Math.toDegrees(r.east),south:C.Math.toDegrees(r.south),north:C.Math.toDegrees(r.north)}):null;setView(old=>old?.key===next?.key?old:next);if(!next)setState({status:'zoom',message:'放大至城市或区域（视野宽、高不超过 160 km），即可查找卫星观测。跨日期变更线时请移至一侧。'});}),700);};
  const start=v.camera.moveStart.addEventListener(()=>{clearTimeout(timer);setPlaying(false);setView(null);setSelected(null);setState({status:'loading',message:'移动结束后查找当前范围的影像…'});});
  const end=v.camera.moveEnd.addEventListener(schedule),resize=new ResizeObserver(schedule);resize.observe(v.container);schedule();
  return()=>{stopped=true;clearTimeout(timer);start();end();resize.disconnect();setView(null);setPlaying(false);clearLayers();clearImages();};
 },[ready,enabled]);
 useEffect(()=>{setPage(0);},[month,view?.key]);
 useEffect(()=>{cancelTransfers();setPlaying(false);setSelected(null);setCatalogue(null);setCatalogueError('');setIndex(0);clearLayers();displaySequence.current++;
  if(!enabled||!view){setCatalogueLoading(false);return;}
  const abort=new AbortController(),signal=abort.signal;
  const q=new URLSearchParams({...Object.fromEntries(Object.entries(view.bounds).map(([k,v])=>[k,String(v)])),mode,kind:experience==='animation'?'sequence':'browse',interval,count:String(count),month,page:String(page)});
  const url='/api/globe/satellite/'+(experience==='quick'?'scene':'timeline')+'?'+q;
  setCatalogueLoading(true);setState({status:'loading',message:experience==='quick'?'正在查找卫星影像…':'正在读取观测时间目录…'});
  void (async()=>{try{
   let data:Catalogue;const hit=metadata.current.get(url);
   if(hit&&Date.now()-hit.at<5*60000)data=hit.data;else{
    const r=await fetch(url,{signal});if(r.status===401){expired.current();return;}const body=await r.json();if(!r.ok)throw Error(body.error||'卫星目录暂不可用');
    data=experience==='quick'?{scenes:body.scene?[body.scene]:[],total:body.scene?1:0,hasMore:false,missing:0,toleranceDays:0}:body;
    if(signal.aborted)return;metadata.current.set(url,{data,at:Date.now()});while(metadata.current.size>24)metadata.current.delete(metadata.current.keys().next().value!);
   }
   if(signal.aborted)return;setCatalogue(data);
   if(!data.scenes.length){setState({status:'empty',message:experience==='quick'?'近 30 天暂无可用观测，请移动到附近陆地或浏览其他月份。':experience==='browse'?'这个月份暂无可用观测，试试前一个月。':'指定时间范围内没有匹配观测，请更换取样间隔。'});return;}
   if(experience!=='browse')setSelected(data.scenes[0]);else setState({status:'idle',message:'选择一个拍摄时间后下载影像。浏览列表不会下载图片。'});
  }catch(error){if(!signal.aborted){const message=error instanceof Error?error.message:'卫星目录加载失败';setCatalogueError(message);setState({status:'error',message});}}finally{if(!signal.aborted)setCatalogueLoading(false);}})();
  return()=>{abort.abort();cancelTransfers();};
 },[enabled,view?.key,experience,mode,interval,count,month,page,revision]);
 // Only this loader downloads images. Browsing catalogue pages never calls it.
 const loadImage=(scene:TimelineScene):Promise<Cached>=>{
  const pending=flights.current.get(scene.key);if(pending)return pending.promise;
  const controller=new AbortController(),signal=controller.signal;
  const promise=(async()=>{
  const existing=cache.current.get(scene.key);if(existing){cache.current.delete(scene.key);cache.current.set(scene.key,existing);return existing;}
  const r=await fetch(scene.imageUrl,{signal});if(r.status===401){expired.current();throw Error('登录已过期');}if(!r.ok){const d=await r.json().catch(()=>({}));throw Error(d.error||'影像加载失败，请重试');}
  const blob=await r.blob();signal.throwIfAborted();const url=URL.createObjectURL(blob);
  try{const C=await import('cesium'),b=scene.bounds,provider=await C.SingleTileImageryProvider.fromUrl(url,{rectangle:C.Rectangle.fromDegrees(b.west,b.south,b.east,b.north),credit:new C.Credit('Contains modified Copernicus Sentinel data · CDSE / Sentinel Hub',true)});signal.throwIfAborted();
   // Coalesce any race between a selected frame and background buffering.
   const duplicate=cache.current.get(scene.key);if(duplicate){URL.revokeObjectURL(url);return duplicate;}
   const item={url,provider,bytes:scene.width*scene.height*4+blob.size};cache.current.set(scene.key,item);
   let bytes=[...cache.current.values()].reduce((sum,item)=>sum+item.bytes,0);
   for(const [key,item] of cache.current){if(cache.current.size<=32&&bytes<=48*1024*1024)break;if(key===activeKey.current||key===scene.key)continue;URL.revokeObjectURL(item.url);cache.current.delete(key);bytes-=item.bytes;}
   setLoaded(new Set(cache.current.keys()));return item;
  }catch(error){URL.revokeObjectURL(url);throw error;}
  })().finally(()=>{if(flights.current.get(scene.key)?.controller===controller)flights.current.delete(scene.key);});
  flights.current.set(scene.key,{controller,promise});return promise;
 };
 useEffect(()=>{const v=viewer.current;if(!enabled||!view||!selected||!v)return;
  const abort=new AbortController(),sequence=++displaySequence.current;let removeReady:(()=>void)|undefined;
  activeKey.current=selected.key;setState(old=>({status:'loading',message:'正在加载所选拍摄时间…',scene:old.scene}));
  cancelTransfers(selected.key);
  const displayTimer=setTimeout(()=>void loadImage(selected).then(item=>{if(abort.signal.aborted||sequence!==displaySequence.current||v.isDestroyed())return;
   const next=v.imageryLayers.addImageryProvider(item.provider,Math.min(1+renderLayers.current.length,v.imageryLayers.length));renderLayers.current.push(next);layer.current=next;stack.current();
   const finish=()=>{if(abort.signal.aborted||!v.scene.globe.tilesLoaded)return;removeReady?.();removeReady=undefined;for(const old of renderLayers.current)if(old!==next&&v.imageryLayers.contains(old))v.imageryLayers.remove(old);renderLayers.current=[next];setState({status:'ready',message:'',scene:selected});v.scene.requestRender();};
   removeReady=v.scene.postRender.addEventListener(finish);v.scene.requestRender();
   // Bound GPU layers even when unrelated base-map tiles cannot finish loading.
   while(renderLayers.current.length>3){const old=renderLayers.current.shift()!;if(v.imageryLayers.contains(old))v.imageryLayers.remove(old);}
  }).catch(error=>{if(!abort.signal.aborted){setPlaying(false);setState(old=>({status:'error',message:error instanceof Error?error.message:'影像加载失败',scene:old.scene}));}}),cache.current.has(selected.key)?0:100);
  return()=>{clearTimeout(displayTimer);abort.abort();removeReady?.();};
 },[enabled,view?.key,selected,imageRevision]);
 // One frame ahead, sequentially: never download an entire 30-frame sequence on entry.
 useEffect(()=>{if(!playing||experience!=='animation'||!catalogue||!view||!enabled||state.status!=='ready')return;
  const next=catalogue.scenes[(index+1)%catalogue.scenes.length];if(!next||loaded.has(next.key))return;
  void loadImage(next).catch(()=>{});
 },[playing,experience,catalogue,index,enabled,view?.key,state.status]);
 useEffect(()=>{if(!playing||state.status!=='ready'||experience!=='animation'||!catalogue||catalogue.scenes.length<2)return;
  const timer=setTimeout(()=>{const next=(index+1)%catalogue.scenes.length;setIndex(next);setSelected(catalogue.scenes[next]);},1000/speed);return()=>clearTimeout(timer);
 },[playing,state.status,index,speed,experience,catalogue]);
 useEffect(()=>{const hide=()=>{if(document.hidden)setPlaying(false);};document.addEventListener('visibilitychange',hide);return()=>document.removeEventListener('visibilitychange',hide);},[]);
 const selectFrame=(i:number)=>{if(!catalogue?.scenes[i])return;setPlaying(false);setIndex(i);setSelected(catalogue.scenes[i]);};
 return {state,layer,experience,setExperience,mode,setMode,interval,setInterval,count,setCount,speed,setSpeed,month,setMonth,page,setPage,catalogue,catalogueLoading,catalogueError,selected,index,playing,setPlaying,loaded,selectFrame,refresh:()=>{metadata.current.clear();refresh(n=>n+1);},retryImage:()=>retryImage(n=>n+1)};
}
export type SatelliteController=ReturnType<typeof useSatellite>;
