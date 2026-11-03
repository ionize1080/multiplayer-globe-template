import {useEffect,useRef,useState,type RefObject} from 'react';
import type {Viewer,ImageryLayer} from 'cesium';
import {contourInterval,contourSegments,terrainColor,TERRAIN_MAX_LEVEL} from '../terrain';
import {TerrainData} from './terrain-data';
export type TerrainOptions={elevation:boolean,hillshade:boolean,contours:boolean};
export async function renderTerrain(grid:Float32Array,z:number,y:number,options:TerrainOptions,cancelled:()=>boolean=()=>false){
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
  const ctx=canvas.getContext('2d')!,pixels=ctx.createImageData(256,256);
  for(let row=0;row<256;row++){
    const lat=Math.atan(Math.sinh(Math.PI*(1-2*(y+(row+.5)/256)/2**z)));
    const spacing=40075016.686*Math.cos(lat)/(256*2**z);
    for(let col=0;col<256;col++){
      const i=row*257+col,h=grid[i];if(!Number.isFinite(h))continue;
      const dx=(grid[i+1]-h)/spacing,dy=(grid[i+257]-h)/spacing;
      // Fixed NW illumination for readable relief; this is not live sunlight.
      const light=Number.isFinite(dx+dy)?Math.max(0,(.5*dx+.5*dy+.7071)/Math.hypot(dx,dy,1)):.7071;
      const color=options.elevation?terrainColor(h):[0,0,0],out=(row*256+col)*4;
      if(options.elevation){const shade=options.hillshade?.55+.65*light:1;for(let k=0;k<3;k++)pixels.data[out+k]=color[k]*shade;pixels.data[out+3]=220;}
      else if(options.hillshade){const bright=light>.7071;pixels.data[out]=pixels.data[out+1]=pixels.data[out+2]=bright?255:15;pixels.data[out+3]=Math.abs(light-.7071)*(bright?160:200);}
    }
    if(row%32===31){await new Promise(resolve=>setTimeout(resolve,0));if(cancelled())throw Error('图层已关闭');}
  }
  ctx.putImageData(pixels,0,0);
  // Global contour labels are unreadable on a curved globe. Reveal them as the
  // imagery reaches regional scales, then refine using the same source heights.
  if(options.contours&&z>=5){
    const interval=contourInterval(z),minor=new Path2D(),major=new Path2D(),labels:{x:number,y:number,h:number}[]=[];
    for(let row=0;row<256;row++){
      for(let col=0;col<256;col++){
        const i=row*257+col,values=[grid[i],grid[i+1],grid[i+258],grid[i+257]];
        if(values.some(v=>!Number.isFinite(v)))continue;
        const lo=Math.min(...values),hi=Math.max(...values);
        for(let h=Math.ceil(lo/interval)*interval;h<hi;h+=interval){
          const isMajor=Math.round(h/interval)%5===0,path=isMajor?major:minor;
          for(const [x1,y1,x2,y2] of contourSegments(values,h)){
            path.moveTo(col+x1+.5,row+y1+.5);path.lineTo(col+x2+.5,row+y2+.5);
            if(isMajor&&z>=11&&col>30&&col<215&&row>24&&row<232&&labels.length<3&&labels.every(p=>Math.hypot(p.x-col,p.y-row)>100))labels.push({x:col,y:row,h});
          }
        }
      }
      if(row%32===31){await new Promise(resolve=>setTimeout(resolve,0));if(cancelled())throw Error('图层已关闭');}
    }
    ctx.strokeStyle='rgba(244,239,218,.35)';ctx.lineWidth=.8;ctx.stroke(minor);
    ctx.strokeStyle='rgba(28,39,49,.9)';ctx.lineWidth=2.2;ctx.stroke(major);
    ctx.strokeStyle='rgba(250,241,209,.8)';ctx.lineWidth=1;ctx.stroke(major);
    ctx.font='10px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineJoin='round';
    for(const p of labels){const text=`${p.h} m`;ctx.strokeStyle='#172331';ctx.lineWidth=3;ctx.strokeText(text,p.x,p.y);ctx.fillStyle='#fff3cd';ctx.fillText(text,p.x,p.y);}
  }
  return canvas;
}
export function useTerrainLayers(viewer:RefObject<Viewer|null>,ready:boolean,options:TerrainOptions,opacity:number,onExpired:()=>void,restack:()=>void){
  const data=useRef<TerrainData|null>(null),layer=useRef<ImageryLayer|null>(null),[error,setError]=useState('');
  const expired=useRef(onExpired),alpha=useRef(opacity);expired.current=onExpired;alpha.current=opacity;
  useEffect(()=>{data.current=new TerrainData(()=>expired.current());return()=>{data.current?.dispose();data.current=null;};},[]);
  useEffect(()=>{
    if(!ready||!(options.elevation||options.hillshade||options.contours))return;
    let cancelled=false;setError('');
    void (async()=>{
      const C=await import('cesium'),v=viewer.current,source=data.current;if(cancelled||!v||!source)return;
      const provider=new C.UrlTemplateImageryProvider({url:'/api/globe/terrain/{z}/{x}/{y}.png',maximumLevel:TERRAIN_MAX_LEVEL,tilingScheme:new C.WebMercatorTilingScheme(),enablePickFeatures:false,credit:new C.Credit('<a href="/data/terrain-attribution.html" target="_blank">Terrain: Mapzen / source credits</a>',true)});
      provider.requestImage=(x:number,y:number,z:number)=>{
        if(cancelled||source.busy)return undefined;
        return source.grid(z,x,y).then(grid=>{if(cancelled)throw Error('图层已关闭');return renderTerrain(grid,z,y,options,()=>cancelled);}).catch(error=>{if(!cancelled)setError('部分地形数据加载失败，可关闭后重开重试');throw error;});
      };
      layer.current=v.imageryLayers.addImageryProvider(provider,1);layer.current.alpha=alpha.current;restack();v.scene.requestRender();
    })().catch(()=>{if(!cancelled)setError('地形图层暂不可用');});
    return()=>{cancelled=true;const v=viewer.current;if(v&&!v.isDestroyed()&&layer.current){v.imageryLayers.remove(layer.current);layer.current=null;v.scene.requestRender();}};
  },[ready,options.elevation,options.hillshade,options.contours]);
  useEffect(()=>{if(layer.current)layer.current.alpha=opacity;viewer.current?.scene.requestRender();},[opacity]);
  return {data,error};
}
