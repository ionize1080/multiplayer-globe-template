import {useEffect,useRef,useState,type RefObject} from 'react';
import type {Viewer,ImageryLayer} from 'cesium';
import {TERRAIN_MAX_LEVEL} from '../terrain';
import {TerrainRenderer} from './terrain-renderer';
import {TerrainData} from './terrain-data';
export type TerrainOptions={elevation:boolean,hillshade:boolean,contours:boolean};
export function useTerrainLayers(viewer:RefObject<Viewer|null>,ready:boolean,options:TerrainOptions,opacity:number,onExpired:()=>void,restack:()=>void){
  const renderer=useRef<TerrainRenderer|null>(null);
  const data=useRef<TerrainData|null>(null),layer=useRef<ImageryLayer|null>(null),[error,setError]=useState('');
  const expired=useRef(onExpired),alpha=useRef(opacity);expired.current=onExpired;alpha.current=opacity;
  useEffect(()=>{data.current=new TerrainData(()=>expired.current());renderer.current=new TerrainRenderer();return()=>{renderer.current?.dispose();renderer.current=null;data.current?.dispose();data.current=null;};},[]);
  useEffect(()=>{
    if(!ready||!(options.elevation||options.hillshade||options.contours))return;
    let cancelled=false;setError('');
    void (async()=>{
      const C=await import('cesium'),v=viewer.current,source=data.current;if(cancelled||!v||!source)return;
      const provider=new C.UrlTemplateImageryProvider({url:'/api/globe/terrain/{z}/{x}/{y}.png',maximumLevel:TERRAIN_MAX_LEVEL,tilingScheme:new C.WebMercatorTilingScheme(),enablePickFeatures:false,credit:new C.Credit('<a href="/data/terrain-attribution.html" target="_blank">Terrain: Mapzen / source credits</a>',true)});
      provider.requestImage=(x:number,y:number,z:number)=>{
        if(cancelled)return undefined;
        if(options.contours&&!options.elevation&&!options.hillshade&&z<5){const empty=document.createElement('canvas');empty.width=empty.height=1;return Promise.resolve(empty);}
        const painter=renderer.current;if(!painter)return undefined;
        const key=`${z}/${x}/${y}/${+options.elevation}${+options.hillshade}${+options.contours}`;const cached=painter.get(key);if(cached)return Promise.resolve(cached);
        if(source.busy||painter.busy)return undefined;
        return source.grid(z,x,y).then(grid=>{if(cancelled)throw Error('图层已关闭');return painter.draw(key,grid,z,y,options,()=>cancelled);}).catch(error=>{if(!cancelled)setError('部分地形数据加载失败，可关闭后重开重试');throw error;});
      };
      layer.current=v.imageryLayers.addImageryProvider(provider,1);layer.current.alpha=alpha.current;restack();v.scene.requestRender();
    })().catch(()=>{if(!cancelled)setError('地形图层暂不可用');});
    return()=>{cancelled=true;const v=viewer.current;if(v&&!v.isDestroyed()&&layer.current){v.imageryLayers.remove(layer.current);layer.current=null;v.scene.requestRender();}};
  },[ready,options.elevation,options.hillshade,options.contours]);
  useEffect(()=>{if(layer.current)layer.current.alpha=opacity;viewer.current?.scene.requestRender();},[opacity]);
  return {data,error,layer};
}
