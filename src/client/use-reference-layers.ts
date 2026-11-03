import {useEffect,useRef,useState,type RefObject} from 'react';
import type {Viewer,DataSource} from 'cesium';
type Place={lon:number;lat:number;name:string;rank:number;kind?:string};
type Loaded={lines?:DataSource;labels?:DataSource};
export function useReferenceLayers(viewer:RefObject<Viewer>,ready:boolean,boundaries:boolean,labels:boolean){
  const [note,setNote]=useState('');
  const coarse=useRef<DataSource|null>(null),overview=useRef<DataSource|null>(null),chunks=useRef(new Map<string,Loaded>());
  const manifest=useRef<Set<string>|null>(null),visible=useRef(new Set<string>());
  // Separate small name payloads from geometry, retaining recent view neighborhoods.
  const payloads=useRef(new Map<string,unknown>()),pending=useRef(new Map<string,Promise<unknown>>());
  useEffect(()=>{
    const v=viewer.current;if(!ready||!v)return;
    let stopped=false,sequence=0,timer:ReturnType<typeof setTimeout>,moving=false,lastLayout=0,refreshLabels:(()=>void)|undefined;
    const sync=()=>{
      for(const [key,data] of chunks.current){if(data.lines)data.lines.show=boundaries&&visible.current.has(key);if(data.labels)data.labels.show=labels&&visible.current.has(key);}
      if(coarse.current)coarse.current.show=boundaries&&!visible.current.size;
      if(overview.current)overview.current.show=labels&&!visible.current.size;
      v.scene.requestRender();
    };
    sync(); // Hide switched-off layers immediately, without waiting for a fetch.
    const json=async<T,>(path:string):Promise<T>=>{
      const cached=payloads.current.get(path);if(cached)return cached as T;
      const running=pending.current.get(path);if(running)return running as Promise<T>;
      const task=(async()=>{const response=await fetch(path);if(!response.ok)throw Error('Reference data unavailable');const value=await response.json();payloads.current.delete(path);payloads.current.set(path,value);while(payloads.current.size>24)payloads.current.delete(payloads.current.keys().next().value!);return value;})();
      pending.current.set(path,task);try{return await task;}finally{pending.current.delete(path);}
    };
    async function update(id:number){
      const C=await import('cesium');if(stopped||id!==sequence||v!.isDestroyed())return;
      const active=()=>!stopped&&id===sequence&&!v!.isDestroyed();
      const makeLabels=(places:Place[])=>{const data=new C.CustomDataSource('Reference names');for(const p of places)data.entities.add({position:C.Cartesian3.fromDegrees(p.lon,p.lat),properties:{rank:p.kind==='province'?5:p.rank,kind:p.kind||'city'},label:{text:p.name,disableDepthTestDistance:Number.POSITIVE_INFINITY,font:p.kind==='province'?'12px sans-serif':'13px sans-serif',fillColor:C.Color.fromCssColorString(p.kind==='province'?'#bbd9eb':'#fff'),outlineColor:C.Color.fromCssColorString('#16202e'),outlineWidth:3,style:C.LabelStyle.FILL_AND_OUTLINE,pixelOffset:new C.Cartesian2(0,-8)}});return data;};
      const layout=()=>{
        if(!labels)return;const height=v!.camera.positionCartographic.height;
        const sources=visible.current.size?[...visible.current].map(k=>chunks.current.get(k)?.labels).filter((s):s is DataSource=>!!s):overview.current?[overview.current]:[];
        const entities=sources.flatMap(s=>s.entities.values).sort((a,b)=>Number(a.properties?.rank?.getValue()??6)-Number(b.properties?.rank?.getValue()??6));
        const seen=new Set<string>(),occupied:{x:number;y:number;w:number;h:number}[]=[],occluder=new C.EllipsoidalOccluder(v!.scene.globe.ellipsoid,v!.camera.positionWC);
        for(const entity of entities){
          entity.show=false;const rank=Number(entity.properties?.rank?.getValue()??6);
          if(height>1500000&&rank>3||height>400000&&rank>5)continue;
          const point=entity.position?.getValue(v!.clock.currentTime);if(!point||!occluder.isPointVisible(point))continue;
          const screen=C.SceneTransforms.worldToWindowCoordinates(v!.scene,point);if(!screen)continue;
          const text=String(entity.label?.text?.getValue()||''),w=Math.max(35,text.length*11),box={x:screen.x-w/2,y:screen.y-18,w,h:22};
          if(seen.has(text)||box.x<0||box.y<0||box.x+w>v!.scene.canvas.clientWidth||box.y+box.h>v!.scene.canvas.clientHeight)continue;
          if(occupied.some(b=>box.x<b.x+b.w&&box.x+box.w>b.x&&box.y<b.y+b.h&&box.y+box.h>b.y))continue;
          occupied.push(box);seen.add(text);entity.show=true;
        }
      };
      refreshLabels=layout;
      try{
        const rect=v!.camera.computeViewRectangle(),height=v!.camera.positionCartographic.height,keys:string[]=[];
        if((boundaries||labels)&&rect&&height<3000000){
          if(!manifest.current)manifest.current=new Set((await json<{tiles:string[]}>('/data/reference/index.json')).tiles);
          const west=C.Math.toDegrees(rect.west),east=C.Math.toDegrees(rect.east)+(rect.east<rect.west?360:0),south=C.Math.toDegrees(rect.south),north=C.Math.toDegrees(rect.north);
          if(east-west<65&&north-south<45)for(let y=Math.max(0,Math.floor((south+90)/20));y<=Math.min(8,Math.floor((north+90)/20));y++)for(let x=Math.floor((west+180)/20);x<=Math.floor((east+180)/20);x++){const key=`${((x%18)+18)%18}-${y}`;if(manifest.current.has(key))keys.push(key);}
        }
        if(!active())return;visible.current=new Set(keys);sync();layout();
        if(!keys.length){
          if(labels&&!overview.current){const places=await json<Place[]>('/data/places.json');if(!active())return;overview.current=makeLabels(places);await v!.dataSources.add(overview.current);layout();v!.scene.requestRender();}
          if(boundaries&&!coarse.current){const payload=await json<object>('/data/boundaries.geojson');if(!active())return;const data=await C.GeoJsonDataSource.load(payload,{stroke:C.Color.fromCssColorString('#e3edf7'),strokeWidth:1.2,clampToGround:false});if(!active())return;coarse.current=data;await v!.dataSources.add(data);}
        }else{
          // Three independent downloads; labels appear before boundary geometry.
          let index=0;
          await Promise.all([0,1,2].map(async()=>{while(index<keys.length&&active()){
            const key=keys[index++];let loaded=chunks.current.get(key);
            if(!loaded){loaded={};chunks.current.set(key,loaded);}else{chunks.current.delete(key);chunks.current.set(key,loaded);}
            if(labels&&!loaded.labels){const places=await json<Place[]>(`/data/reference/${key}.places.json`);if(!active())return;loaded.labels=makeLabels(places);await v!.dataSources.add(loaded.labels);layout();sync();}
            if(boundaries&&!loaded.lines){const payload=await json<object>(`/data/reference/${key}.json`);if(!active())return;
              const lines=await C.GeoJsonDataSource.load(payload,{stroke:C.Color.fromCssColorString('#dce9f3'),strokeWidth:1.1,clampToGround:false});if(!active())return;
              for(const entity of lines.entities.values)if(entity.polyline&&entity.properties?.kind?.getValue()==='province')entity.polyline.material=new C.ColorMaterialProperty(C.Color.fromCssColorString('#a6c2d8').withAlpha(.65));
              loaded.lines=lines;await v!.dataSources.add(lines);sync();
            }
          }}));
        }
        if(!active())return;
        for(const [key,data] of chunks.current){if(chunks.current.size<=Math.max(8,keys.length))break;if(visible.current.has(key))continue;if(data.lines)v!.dataSources.remove(data.lines,true);if(data.labels)v!.dataSources.remove(data.labels,true);chunks.current.delete(key);}
        sync();layout();setNote(keys.length?'Natural Earth · 1:1000万参考界线 / 省州 / 城市':'Natural Earth · 全球参考界线 / 主要城市');v!.scene.requestRender();
      }catch{if(active())setNote('部分地理数据暂不可用，已加载图层保留');}
    }
    function schedule(delay=150){const id=++sequence;clearTimeout(timer);timer=setTimeout(()=>void update(id),delay);}
    const removeStart=v.camera.moveStart.addEventListener(()=>{moving=true;});
    const remove=v.camera.moveEnd.addEventListener(()=>{moving=false;schedule();});
    const removeFrame=v.scene.preRender.addEventListener(()=>{if(moving&&Date.now()-lastLayout>100){lastLayout=Date.now();refreshLabels?.();}});
    const resize=new ResizeObserver(()=>schedule());resize.observe(v.container);schedule(0);
    return()=>{stopped=true;sequence++;clearTimeout(timer);remove();removeStart();removeFrame();resize.disconnect();};
  },[ready,boundaries,labels]);
  return note;
}
