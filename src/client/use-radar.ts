import {useEffect,useState,type RefObject} from 'react';
import type {Viewer,ImageryLayer} from 'cesium';
export type RadarFrame={time:number;path:string};
export function validRadarFrames(payload:{radar?:{past?:RadarFrame[]}}):RadarFrame[]{return (payload.radar?.past||[]).filter(f=>Number.isFinite(f.time)&&/^\/v2\/radar\/[a-zA-Z0-9_-]+$/.test(f.path)).sort((a,b)=>a.time-b.time).slice(-13);}
export function useRadar(viewer:RefObject<Viewer>,ready:boolean,enabled:boolean){
 const [frames,setFrames]=useState<RadarFrame[]>([]),[index,setIndex]=useState(0),[playing,setPlaying]=useState(false),[error,setError]=useState('');
 useEffect(()=>{if(!enabled||!ready){setPlaying(false);return;}let stopped=false;const abort=new AbortController();const update=async()=>{try{const r=await fetch('https://api.rainviewer.com/public/weather-maps.json',{signal:abort.signal});if(!r.ok)throw Error();const data=validRadarFrames(await r.json());if(!data.length)throw Error();if(!stopped){setFrames(data);setIndex(data.length-1);setError(Date.now()-data[data.length-1].time*1000>3600000?'最新雷达帧超过 1 小时，数据可能延迟':'');}}catch{if(!stopped)setError('雷达索引加载失败，请稍后切换图层重试');}};void update();const timer=setInterval(update,10*60000);return()=>{stopped=true;abort.abort();clearInterval(timer);};},[ready,enabled]);
 useEffect(()=>{if(!enabled||!playing||frames.length<2)return;const timer=setInterval(()=>setIndex(i=>(i+1)%frames.length),1000);return()=>clearInterval(timer);},[enabled,playing,frames]);
 useEffect(()=>{const v=viewer.current;if(!v||!ready||!enabled)return;let stopped=false;const layers=new Map<string,ImageryLayer>();let removeError:(()=>void)|undefined;const frame=frames[index];if(!frame)return;
 void import('cesium').then(C=>{if(stopped||v.isDestroyed())return;const provider=new C.UrlTemplateImageryProvider({url:`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/2/1_0.png`,maximumLevel:7,credit:new C.Credit('<a href="https://www.rainviewer.com/">Weather data by RainViewer</a>',true)});removeError=provider.errorEvent.addEventListener(()=>{if(!stopped){setError('部分雷达瓦片未加载；空白不代表无降水');setPlaying(false);}});const layer=v.imageryLayers.addImageryProvider(provider);layer.alpha=.8;layers.set(frame.path,layer);v.scene.requestRender();});
 return()=>{stopped=true;removeError?.();if(!v.isDestroyed()){for(const l of layers.values())v.imageryLayers.remove(l);v.scene.requestRender();}};
 },[ready,enabled,frames,index]);
 return {frames,index,setIndex,playing,setPlaying,error};
}
