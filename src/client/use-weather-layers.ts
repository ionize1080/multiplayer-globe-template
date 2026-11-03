import type {WeatherField} from './weather-palettes';
import {useEffect,useRef,useState,type RefObject,type MutableRefObject} from 'react';
import type {Viewer,ImageryLayer} from 'cesium';
import {planWeatherTiles,type Bounds,type WeatherGrid,type WeatherTile} from '../weather-tiles';
import {drawWeather} from './weather-render';

export function useWeatherLayers(viewer:RefObject<Viewer>,ready:boolean,temperature:boolean,wind:boolean,opacity:MutableRefObject<number>,colorLayer:MutableRefObject<ImageryLayer|null>,windLayer:MutableRefObject<ImageryLayer|null>,restack:()=>void,onExpired:()=>void,field:WeatherField='temperature'){
  const [note,setNote]=useState('');
  const global=useRef<WeatherGrid|null>(null),tiles=useRef(new Map<string,WeatherTile>());
  const pending=useRef(new Map<string,Promise<WeatherTile>>()),globalPending=useRef<Promise<WeatherGrid>|null>(null);
  const cooldown=useRef(0),lastFetch=useRef(0);
  useEffect(()=>{
    if(!ready||(!temperature&&!wind))return;
    let stopped=false,sequence=0,timer:ReturnType<typeof setTimeout>,removeMove:(()=>void)|undefined,resize:ResizeObserver|undefined;
    const v=viewer.current;if(!v)return;
    const globalData=()=>{
      if(global.current&&Date.now()-Date.parse(global.current.fetchedAt)<15*60000)return Promise.resolve(global.current);
      if(!globalPending.current)globalPending.current=(async()=>{const response=await fetch('/api/globe/weather?v=2');if(response.status===401)onExpired();if(!response.ok)throw Error('全球概览暂不可用');const data=await response.json() as WeatherGrid;global.current=data;return data;})().finally(()=>{globalPending.current=null;});
      return globalPending.current;
    };
    const tileData=async(tile:ReturnType<typeof planWeatherTiles>[number],stillNeeded:()=>boolean)=>{
      const existing=tiles.current.get(tile.key);
      if(existing&&!existing.stale&&Date.now()-Date.parse(existing.fetchedAt)<1800000)return Promise.resolve(existing);
      const running=pending.current.get(tile.key);if(running)return running;
      while(pending.current.size>=2)await Promise.race([...pending.current.values()].map(p=>p.catch(()=>null)));
      if(!stillNeeded())throw Error('视野已改变');
      const completed=tiles.current.get(tile.key);if(completed&&!completed.stale&&Date.now()-Date.parse(completed.fetchedAt)<1800000)return completed;
      const joined=pending.current.get(tile.key);if(joined)return joined;
      if(Date.now()<cooldown.current)return Promise.reject(Error('请求限额保护中，保留概览或已缓存数据'));
      const promise=(async()=>{
        const response=await fetch(`/api/globe/tile?v=2&level=${tile.level}&x=${tile.x}&y=${tile.y}`);
        if(response.status===401){onExpired();throw Error('登录已过期');}
        if(response.status===429){cooldown.current=Date.now()+60000;throw Error('请求限额保护中，保留概览或已缓存数据');}
        if(!response.ok)throw Error('细网格暂不可用，保留概览或已缓存数据');
        const data=await response.json() as WeatherTile;tiles.current.delete(tile.key);tiles.current.set(tile.key,data);
        if(tiles.current.size>96)tiles.current.delete(tiles.current.keys().next().value!);
        return data;
      })().finally(()=>{pending.current.delete(tile.key);});
      pending.current.set(tile.key,promise);return promise;
    };
    async function update(id:number){
      const C=await import('cesium');if(stopped||id!==sequence||v!.isDestroyed())return;
      const rectangle=v!.camera.computeViewRectangle();
      const bounds:Bounds=rectangle?{west:C.Math.toDegrees(rectangle.west),east:C.Math.toDegrees(rectangle.east),south:C.Math.toDegrees(rectangle.south),north:C.Math.toDegrees(rectangle.north)}:{west:-180,east:180,south:-90,north:90};
      const plan=planWeatherTiles(bounds),drawingBounds=plan.length?bounds:{west:-180,east:180,south:-90,north:90};
      let warning='';setNote(plan.length?`正在加载视野细网格 · ${plan[0].resolution}° 显示采样`:'正在加载全球概览…');
      try{await globalData();}catch(error){warning=error instanceof Error?error.message:'概览暂不可用';}
      if(stopped||id!==sequence)return;
      const cachedTiles=()=>plan.map(t=>tiles.current.get(t.key)).filter((t):t is WeatherTile=>!!t&&Date.now()-Date.parse(t.fetchedAt)<6*3600000);
      async function render(){
        const data=cachedTiles(),canvas=v!.scene.canvas;
        const width=plan.length?Math.max(512,Math.min(1536,Math.round(canvas.clientWidth*1.5))):1440;
        const height=plan.length?Math.max(384,Math.min(1024,Math.round(canvas.clientHeight*1.5))):720;
        const project=<T extends WeatherGrid>(grid:T):T=>field==='temperature'?grid:{...grid,points:grid.points.map(p=>({...p,temperature:p[field]??null}))};
        const result=await drawWeather(drawingBounds,global.current?project(global.current):null,data.map(project),temperature,wind,width,height,()=>stopped||id!==sequence,field);
        if(!result||stopped||id!==sequence)return;
        const rect=C.Rectangle.fromDegrees(drawingBounds.west,drawingBounds.south,drawingBounds.east,drawingBounds.north);
        const provider=await C.SingleTileImageryProvider.fromUrl(result.canvas.toDataURL(),{rectangle:rect,credit:new C.Credit('<a href="https://open-meteo.com/">Weather: Open-Meteo</a>',true)});
        const arrowProvider=wind?await C.SingleTileImageryProvider.fromUrl(result.arrows.toDataURL(),{rectangle:rect}):null;
        if(stopped||id!==sequence||v!.isDestroyed())return;
        if(colorLayer.current)v!.imageryLayers.remove(colorLayer.current);if(windLayer.current)v!.imageryLayers.remove(windLayer.current);
        colorLayer.current=v!.imageryLayers.addImageryProvider(provider);colorLayer.current.alpha=opacity.current;
        windLayer.current=arrowProvider?v!.imageryLayers.addImageryProvider(arrowProvider):null;restack();
        const times=[...(data.length===plan.length&&plan.length?[]:global.current?.points||[]),...data.flatMap(t=>t.points)].map(p=>p.time).filter((t):t is string=>!!t).sort();
        const timeLabel=times[0]?new Date(times[0]).toLocaleString()+(times.at(-1)!==times[0]?' – '+new Date(times.at(-1)!).toLocaleTimeString():''):'时间未知';
        const summary=plan.length?`${plan[0].resolution}° 显示采样 · 细网格 ${data.length}/${plan.length}${temperature&&field==='temperature'&&data.length?' · 等温线 5°C':''}`:'15° 全球概览';
        setNote(`${summary} · ${timeLabel} · 原生模型精度因地区而异，非实测${data.some(t=>t.stale||Date.now()-Date.parse(t.fetchedAt)>1800000)?' · 使用旧缓存':''}${warning?' · '+warning:''}`);
      }
      // Show cached detail/coarse fallback first. Exactly two tile requests in flight.
      await render();if(stopped||id!==sequence||!plan.length)return;
      let index=0;
      await Promise.all([0,1].map(async()=>{while(index<plan.length&&!stopped&&id===sequence){const tile=plan[index++];try{await tileData(tile,()=>!stopped&&id===sequence);}catch(error){warning=error instanceof Error?error.message:'细网格暂不可用';}}}));
      if(!stopped&&id===sequence)await render();
    }
    function schedule(){sequence++;clearTimeout(timer);const id=sequence;timer=setTimeout(()=>{lastFetch.current=Date.now();void update(id).catch(()=>{if(!stopped&&id===sequence)setNote('天气加载失败，已显示图层保留');});},Math.max(900,5000-(Date.now()-lastFetch.current)));}
    removeMove=v.camera.moveEnd.addEventListener(schedule);const removeStart=v.camera.moveStart.addEventListener(()=>{if(windLayer.current)windLayer.current.show=false;});resize=new ResizeObserver(schedule);resize.observe(v.container);
    schedule();const interval=setInterval(schedule,60000);
    return()=>{stopped=true;sequence++;clearTimeout(timer);clearInterval(interval);removeMove?.();removeStart();resize?.disconnect();if(!v.isDestroyed()){if(colorLayer.current)v.imageryLayers.remove(colorLayer.current);if(windLayer.current)v.imageryLayers.remove(windLayer.current);colorLayer.current=null;windLayer.current=null;v.scene.requestRender();}};
  },[ready,temperature,wind,field]);
  return note;
}
