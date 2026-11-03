import React,{useEffect,useState,type RefObject} from 'react';
import type {Viewer} from 'cesium';
import type {TerrainRenderer} from './terrain-renderer';
export function ContourLabels({viewer,renderer,enabled,ready}:{viewer:RefObject<Viewer>;renderer:RefObject<TerrainRenderer>;enabled:boolean;ready:boolean}){
 const [labels,setLabels]=useState<{x:number;y:number;h:number}[]>([]);
 useEffect(()=>{const v=viewer.current;if(!v||!enabled||!ready)return;let stopped=false,remove:(()=>void)|undefined;
 void import('cesium').then(C=>{if(stopped)return;let last=0;remove=v.scene.postRender.addEventListener(()=>{if(Date.now()-last<120)return;last=Date.now();const occluder=new C.EllipsoidalOccluder(v.scene.globe.ellipsoid,v.camera.positionWC),result:{x:number;y:number;h:number}[]=[];const items=[...(renderer.current?.labels.values()||[])].flat().sort((a,b)=>b.z-a.z);
 for(const p of items){const world=C.Cartesian3.fromDegrees(p.lon,p.lat);if(v.scene.mode===C.SceneMode.SCENE3D&&!occluder.isPointVisible(world))continue;const xy=C.SceneTransforms.worldToWindowCoordinates(v.scene,world);if(!xy||xy.x<30||xy.y<175||xy.x>v.scene.canvas.clientWidth-170||xy.y>v.scene.canvas.clientHeight-180)continue;const edge=C.SceneTransforms.worldToWindowCoordinates(v.scene,C.Cartesian3.fromDegrees(p.lon+360/2**p.z,p.lat));if(!edge)continue;const size=Math.hypot(edge.x-xy.x,edge.y-xy.y);if(size<100||size>650)continue;if(result.some(q=>Math.abs(q.x-xy.x)<100&&Math.abs(q.y-xy.y)<45))continue;result.push({x:xy.x,y:xy.y,h:p.h});if(result.length>=48)break;}setLabels(result);});v.scene.requestRender();});
 return()=>{stopped=true;remove?.();};},[enabled,ready]);
 return enabled?<div className="contour-labels" aria-label="等高线高程标注">{labels.map((p,i)=><span key={i} style={{left:Math.round(p.x),top:Math.round(p.y)}}>{p.h.toLocaleString()} m</span>)}</div>:null;
}
