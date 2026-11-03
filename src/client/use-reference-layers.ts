import {useEffect,useRef,useState,type RefObject} from 'react';
import type {Viewer,DataSource} from 'cesium';
type Place={lon:number;lat:number;name:string;rank:number;kind?:string};
type Chunk={type:'FeatureCollection';features:unknown[];places:Place[]};
type Loaded={lines:DataSource;labels:DataSource};
export function useReferenceLayers(viewer:RefObject<Viewer>,ready:boolean,boundaries:boolean,labels:boolean){
  const [note,setNote]=useState('');
  const coarse=useRef<DataSource|null>(null),overview=useRef<DataSource|null>(null),chunks=useRef(new Map<string,Loaded>());
  const manifest=useRef<Set<string>|null>(null);
  useEffect(()=>{
    const v=viewer.current;if(!ready||!v)return;
    let stopped=false,sequence=0,timer:ReturnType<typeof setTimeout>;
    async function update(id:number){
      const C=await import('cesium');if(stopped||id!==sequence||v!.isDestroyed())return;
      const active=()=>!stopped&&id===sequence&&!v!.isDestroyed();
      const makeLabels=(places:Place[])=>{const data=new C.CustomDataSource('Reference names');for(const p of places)data.entities.add({position:C.Cartesian3.fromDegrees(p.lon,p.lat),properties:{rank:p.kind==='province'?5:p.rank,kind:p.kind||'city'},label:{text:p.name,font:p.kind==='province'?'12px sans-serif':'13px sans-serif',fillColor:C.Color.fromCssColorString(p.kind==='province'?'#bbd9eb':'#fff'),outlineColor:C.Color.fromCssColorString('#16202e'),outlineWidth:3,style:C.LabelStyle.FILL_AND_OUTLINE,pixelOffset:new C.Cartesian2(0,-8)}});return data;};
      try{
        if(boundaries&&!coarse.current){const data=await C.GeoJsonDataSource.load('/data/boundaries.geojson',{stroke:C.Color.fromCssColorString('#e3edf7'),strokeWidth:1.2,clampToGround:true});if(!active())return;coarse.current=data;await v!.dataSources.add(data);}
        if(labels&&!overview.current){const r=await fetch('/data/places.json');if(!r.ok)throw Error();const data=makeLabels(await r.json());if(!active())return;overview.current=data;await v!.dataSources.add(data);}
        const rect=v!.camera.computeViewRectangle(),height=v!.camera.positionCartographic.height;
        const keys:string[]=[];
        if((boundaries||labels)&&rect&&height<3000000){
          if(!manifest.current){const r=await fetch('/data/reference/index.json');if(!r.ok)throw Error();manifest.current=new Set((await r.json() as {tiles:string[]}).tiles);}
          const west=C.Math.toDegrees(rect.west),east=C.Math.toDegrees(rect.east)+(rect.east<rect.west?360:0),south=C.Math.toDegrees(rect.south),north=C.Math.toDegrees(rect.north);
          if(east-west<65&&north-south<45)for(let y=Math.max(0,Math.floor((south+90)/20));y<=Math.min(8,Math.floor((north+90)/20));y++)for(let x=Math.floor((west+180)/20);x<=Math.floor((east+180)/20);x++){const key=`${((x%18)+18)%18}-${y}`;if(manifest.current.has(key))keys.push(key);}
        }
        if(!active())return;
        for(const [key,data] of chunks.current){data.lines.show=boundaries&&keys.includes(key);data.labels.show=labels&&keys.includes(key);}
        if(coarse.current)coarse.current.show=boundaries;if(overview.current)overview.current.show=labels;
        // Bound geometry/memory to the current neighborhood; static HTTP caching handles revisits.
        for(const [key,data] of chunks.current)if(!keys.includes(key)){v!.dataSources.remove(data.lines,true);v!.dataSources.remove(data.labels,true);chunks.current.delete(key);}
        for(const key of keys){
          if(!active())return;if(chunks.current.has(key))continue;
          const r=await fetch(`/data/reference/${key}.json`);if(!r.ok)throw Error();const payload=await r.json() as Chunk;
          const lines=await C.GeoJsonDataSource.load(payload,{stroke:C.Color.fromCssColorString('#dce9f3'),strokeWidth:1.1,clampToGround:true});
          if(!active())return;
          for(const entity of lines.entities.values)if(entity.polyline&&entity.properties?.kind?.getValue()==='province')entity.polyline.material=new C.ColorMaterialProperty(C.Color.fromCssColorString('#a6c2d8').withAlpha(.65));
          const names=makeLabels(payload.places);chunks.current.set(key,{lines,labels:names});lines.show=boundaries;names.show=labels;
          await v!.dataSources.add(lines);await v!.dataSources.add(names);
        }
        if(!active())return;
        if(coarse.current)coarse.current.show=boundaries&&!keys.length;
        if(overview.current)overview.current.show=labels&&!keys.length;
        // Screen-space collision checks retain important names and never stack text.
        const sources=keys.length?keys.map(k=>chunks.current.get(k)!.labels):overview.current?[overview.current]:[];
        const entities=sources.flatMap(s=>s.entities.values).sort((a,b)=>Number(a.properties?.rank?.getValue()??6)-Number(b.properties?.rank?.getValue()??6));
        const seen=new Set<string>(),occupied:{x:number;y:number;w:number;h:number}[]=[],occluder=new C.EllipsoidalOccluder(v!.scene.globe.ellipsoid,v!.camera.positionWC);
        for(const entity of entities){
          entity.show=false;const rank=Number(entity.properties?.rank?.getValue()??6);
          if(height>1500000&&rank>3||height>400000&&rank>5)continue;
          const point=entity.position?.getValue(v!.clock.currentTime);if(!point||!occluder.isPointVisible(point))continue;
          const screen=C.SceneTransforms.worldToWindowCoordinates(v!.scene,point);if(!screen)continue;
          const text=String(entity.label?.text?.getValue()||''),w=Math.max(35,text.length*11),box={x:screen.x-w/2,y:screen.y-18,w,h:22};
          if(seen.has(text))continue;
          if(box.x<0||box.y<0||box.x+w>v!.scene.canvas.clientWidth||box.y+box.h>v!.scene.canvas.clientHeight)continue;
          if(occupied.some(b=>box.x<b.x+b.w&&box.x+box.w>b.x&&box.y<b.y+b.h&&box.y+box.h>b.y))continue;
          occupied.push(box);seen.add(text);entity.show=true;
        }
        setNote(keys.length?'Natural Earth · 1:1000万参考界线 / 省州 / 城市':'Natural Earth · 全球参考界线 / 主要城市');v!.scene.requestRender();
      }catch{if(active())setNote('细地理数据暂不可用，已加载图层保留');}
    }
    function schedule(){const id=++sequence;clearTimeout(timer);timer=setTimeout(()=>void update(id),350);}
    const remove=v.camera.moveEnd.addEventListener(schedule),resize=new ResizeObserver(schedule);resize.observe(v.container);schedule();
    return()=>{stopped=true;sequence++;clearTimeout(timer);remove();resize.disconnect();};
  },[ready,boundaries,labels]);
  return note;
}
