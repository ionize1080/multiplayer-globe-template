import {terrainImageryRectangle} from './terrain-imagery';
import {visibleRectangle} from './visible-rectangle';
import {useEffect,useRef,useState,type RefObject} from 'react';
import type {Viewer,ImageryLayer} from 'cesium';
import {TERRAIN_MAX_LEVEL,terrainViewPlan} from '../terrain';
import {TerrainRenderer} from './terrain-renderer';
import {TerrainData} from './terrain-data';
export type TerrainOptions={elevation:boolean,hillshade:boolean,contours:boolean};
export function useTerrainLayers(viewer:RefObject<Viewer|null>,ready:boolean,options:TerrainOptions,opacity:number,onExpired:()=>void,restack:()=>void){
  const [plan,setPlan]=useState<ReturnType<typeof terrainViewPlan>|null>(null),retired=useRef<ImageryLayer[]>([]);
  const renderer=useRef<TerrainRenderer|null>(null);
  const data=useRef<TerrainData|null>(null),layer=useRef<ImageryLayer|null>(null),[error,setError]=useState('');
  const expired=useRef(onExpired),alpha=useRef(opacity);expired.current=onExpired;alpha.current=opacity;
  useEffect(()=>{data.current=new TerrainData(()=>expired.current());renderer.current=new TerrainRenderer();return()=>{renderer.current?.dispose();renderer.current=null;data.current?.dispose();data.current=null;};},[]);
  useEffect(()=>{const v=viewer.current;if(!ready||!v)return;let stopped=false,timer:ReturnType<typeof setTimeout>;const update=async()=>{const C=await import('cesium');if(stopped||v.isDestroyed())return;const r=visibleRectangle(v,C);const next=terrainViewPlan(r?{west:C.Math.toDegrees(r.west),east:C.Math.toDegrees(r.east),south:C.Math.toDegrees(r.south),north:C.Math.toDegrees(r.north)}:{west:-180,east:180,south:-90,north:90});setPlan(old=>old?.key===next.key?old:next);};const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>void update(),180);};const remove=v.camera.moveEnd.addEventListener(schedule);const resize=new ResizeObserver(schedule);resize.observe(v.container);void update();return()=>{stopped=true;clearTimeout(timer);remove();resize.disconnect();};},[ready]);
  useEffect(()=>()=>{const v=viewer.current;if(v&&!v.isDestroyed()){for(const old of retired.current)if(v.imageryLayers.contains(old))v.imageryLayers.remove(old);if(layer.current&&v.imageryLayers.contains(layer.current))v.imageryLayers.remove(layer.current);}retired.current=[];},[]);
  useEffect(()=>{
    if(!ready||!plan)return;
    if(!(options.elevation||options.hillshade||options.contours)){const v=viewer.current;if(v&&!v.isDestroyed()){for(const old of retired.current)if(v.imageryLayers.contains(old))v.imageryLayers.remove(old);if(layer.current)v.imageryLayers.remove(layer.current);layer.current=null;retired.current=[];v.scene.requestRender();}return;}
    let cancelled=false,retireTimer:ReturnType<typeof setTimeout>|undefined;setError('');
    void (async()=>{
      const C=await import('cesium'),v=viewer.current,source=data.current;if(cancelled||!v||!source)return;
      const provider=new C.UrlTemplateImageryProvider({url:'/api/globe/terrain/{z}/{x}/{y}.png',minimumLevel:plan.minimumLevel,rectangle:terrainImageryRectangle(C,plan),maximumLevel:TERRAIN_MAX_LEVEL,tilingScheme:new C.WebMercatorTilingScheme(),enablePickFeatures:false,credit:new C.Credit('<a href="/data/terrain-attribution.html" target="_blank">Terrain: Mapzen / source credits</a>',true)});
      // Never mutate imageryLayers inside Cesium's requestImage traversal.
      const clearRetired=()=>{if(retireTimer!==undefined)return;retireTimer=setTimeout(()=>{retireTimer=undefined;if(cancelled||v.isDestroyed())return;for(const old of retired.current)if(v.imageryLayers.contains(old))v.imageryLayers.remove(old);retired.current=[];v.scene.requestRender();},0);};
      provider.requestImage=(x:number,y:number,z:number)=>{
        if(cancelled)return undefined;
        if(options.contours&&!options.elevation&&!options.hillshade&&z<5){clearRetired();const empty=document.createElement('canvas');empty.width=empty.height=1;return Promise.resolve(empty);}
        const painter=renderer.current;if(!painter)return undefined;
        const key=`${z}/${x}/${y}/${+options.elevation}${+options.hillshade}${+options.contours}`;const cached=painter.get(key);if(cached){clearRetired();return Promise.resolve(cached);}
        if(source.busy||painter.busy)return undefined;
        return source.grid(z,x,y).then(grid=>{if(cancelled)throw Error('图层已关闭');return painter.draw(key,grid,z,y,options,()=>cancelled);}).then(canvas=>{clearRetired();return canvas;}).catch(error=>{if(!cancelled)setError('部分地形数据加载失败，可关闭后重开重试');throw error;});
      };
      if(layer.current)retired.current.push(layer.current);while(retired.current.length>1){const old=retired.current.shift()!;if(v.imageryLayers.contains(old))v.imageryLayers.remove(old);}
      layer.current=v.imageryLayers.addImageryProvider(provider,1);layer.current.alpha=alpha.current;restack();v.scene.requestRender();
    })().catch(error=>{console.warn('Terrain setup:',error);if(!cancelled)setError('地形图层暂不可用');});
    return()=>{cancelled=true;clearTimeout(retireTimer);};
  },[ready,options.elevation,options.hillshade,options.contours,plan]);
  useEffect(()=>{if(layer.current)layer.current.alpha=opacity;viewer.current?.scene.requestRender();},[opacity]);
  return {data,error,layer,renderer};
}
