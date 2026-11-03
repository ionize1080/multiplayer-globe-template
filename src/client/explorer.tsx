import React,{useEffect,useRef,useState} from 'react';
import type {Viewer,ImageryLayer} from 'cesium';
type Point={lat:number,lon:number,time:string|null,temperature:number|null,wind:number|null,direction:number|null};
type Grid={points:Point[],fetchedAt:string,resolution:number};
export default function Explorer({onExpired}:{onExpired:()=>void}) {
  const container=useRef<HTMLDivElement>(null), viewer=useRef<Viewer|null>(null);
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[clouds,setClouds]=useState(false),[layer,setLayer]=useState<'none'|'temperature'|'wind'>('none'),[opacity,setOpacity]=useState(.55),[note,setNote]=useState(''),[cloudNote,setCloudNote]=useState(''),[height,setHeight]=useState(''),[selected,setSelected]=useState('');
  const weatherLayer=useRef<ImageryLayer|null>(null),cloudLayer=useRef<ImageryLayer|null>(null),grid=useRef<Grid|null>(null);
  useEffect(()=>{
    let cancelled=false;let cleanup: (()=>void)|undefined;
    const css=document.createElement('link');css.rel='stylesheet';css.href='/dist/cesium/Widgets/widgets.css';document.head.append(css);
    void (async()=>{
      const C=await import('cesium');if(cancelled||!container.current)return;
      C.Ion.defaultAccessToken='';
      const v=new C.Viewer(container.current,{baseLayer:false,baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,animation:false,timeline:false,fullscreenButton:false,infoBox:false,selectionIndicator:false,requestRenderMode:true,maximumRenderTimeChange:Infinity});viewer.current=v;
      v.scene.screenSpaceCameraController.minimumZoomDistance=100;
      v.scene.screenSpaceCameraController.maximumZoomDistance=50000000;
      v.scene.globe.maximumScreenSpaceError=2;
      v.camera.setView({destination:C.Cartesian3.fromDegrees(103.82,1.35,21000000)});
      try{const saved=JSON.parse(sessionStorage.getItem('ionize-explore-camera')||'null');if(saved&&[saved.lon,saved.lat,saved.height].every(Number.isFinite))v.camera.setView({destination:C.Cartesian3.fromDegrees(saved.lon,saved.lat,Math.max(100,Math.min(50000000,saved.height)))});}catch{}
      const move=()=>{const p=v.camera.positionCartographic;setHeight(p.height>1000?`${(p.height/1000).toFixed(1)} km`:`${p.height.toFixed(0)} m`);try{sessionStorage.setItem('ionize-explore-camera',JSON.stringify({lon:C.Math.toDegrees(p.longitude),lat:C.Math.toDegrees(p.latitude),height:p.height}));}catch{}};
      const remove=v.camera.moveEnd.addEventListener(move);move();
      const click=new C.ScreenSpaceEventHandler(v.scene.canvas);
      click.setInputAction((e:{position:import('cesium').Cartesian2})=>{const point=v.camera.pickEllipsoid(e.position,v.scene.globe.ellipsoid);if(!point)return;const cart=C.Cartographic.fromCartesian(point),lat=C.Math.toDegrees(cart.latitude),lon=C.Math.toDegrees(cart.longitude);const nearest=grid.current?.points.reduce((a,b)=>{const distance=(p:Point)=>Math.abs(p.lat-lat)+Math.abs(((p.lon-lon+540)%360)-180)*Math.cos(cart.latitude);return distance(a)<distance(b)?a:b;});setSelected(`${lat.toFixed(3)}°, ${lon.toFixed(3)}°${nearest?` · 最近网格：${nearest.temperature??'—'} °C / ${nearest.wind??'—'} m/s`:''}`);},C.ScreenSpaceEventType.LEFT_CLICK);
      cleanup=()=>{remove();click.destroy();v.destroy();viewer.current=null;};
      try {
        const imagery=await C.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',{enablePickFeatures:false,maximumLevel:19});
        if(cancelled)return;v.imageryLayers.addImageryProvider(imagery);v.scene.requestRender();setReady(true);
      }catch{if(!cancelled)setError('卫星底图暂不可用，请稍后重新进入。');}
    })().catch(()=>{if(!cancelled)setError('当前设备无法启动地图，请尝试支持 WebGL 的浏览器。');});
    return()=>{cancelled=true;cleanup?.();css.remove();};
  },[]);
  useEffect(()=>{
    if(!ready||!clouds)return;let cancelled=false;const abort=new AbortController();
    async function update(){try{const res=await fetch('/api/globe/clouds',{signal:abort.signal});if(res.status===401){onExpired();return;}if(!res.ok)throw Error();const meta=await res.json();const C=await import('cesium');const image=await C.SingleTileImageryProvider.fromUrl(meta.texturePath,{rectangle:C.Rectangle.MAX_VALUE,credit:'Contains modified EUMETSAT data · Live Cloud Maps'});if(cancelled||!viewer.current)return;const v=viewer.current;if(cloudLayer.current)v.imageryLayers.remove(cloudLayer.current);cloudLayer.current=v.imageryLayers.addImageryProvider(image);cloudLayer.current.alpha=.6;v.scene.requestRender();setCloudNote(`EUMETSAT · 约 3 小时发布 · ${meta.publishedAt?new Date(meta.publishedAt).toLocaleString():'观测时间未知'}`);}catch{if(!cancelled)setCloudNote('云图刷新失败，已加载的图层保留');}}
    void update();const timer=setInterval(update,15*60000);
    return()=>{cancelled=true;abort.abort();clearInterval(timer);const v=viewer.current;if(v&&cloudLayer.current){v.imageryLayers.remove(cloudLayer.current);cloudLayer.current=null;v.scene.requestRender();}};
  },[ready,clouds]);
  useEffect(()=>{
    if(!ready||layer==='none')return;let cancelled=false;const abort=new AbortController();setNote('正在读取天气网格…');
    async function update(){try{const res=await fetch('/api/globe/weather',{signal:abort.signal});if(res.status===401){onExpired();return;}if(!res.ok)throw Error();const data:Grid=await res.json();const C=await import('cesium');if(cancelled||!viewer.current)return;grid.current=data;
      const canvas=document.createElement('canvas');canvas.width=720;canvas.height=360;const ctx=canvas.getContext('2d')!;
      // Bilinear display interpolation improves readability, not source resolution.
      const pixels=ctx.createImageData(720,360), field=layer==='temperature'?'temperature':'wind';
      for(let y=30;y<330;y++)for(let x=0;x<720;x++){
        const u=x/30,v=(90-y/2+75)/15,lo=Math.floor(v),hi=Math.min(10,lo+1),left=Math.floor(u)%24,right=(left+1)%24;
        const values=[data.points[lo*24+left][field],data.points[lo*24+right][field],data.points[hi*24+left][field],data.points[hi*24+right][field]];
        if(values.some(n=>n===null))continue;const [a,b,c,d]=values as number[],fx=u-Math.floor(u),fy=v-lo,value=(a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+d*fx)*fy;
        const t=Math.max(0,Math.min(1,layer==='temperature'?(value+30)/75:value/30)),h=(240-240*t)/60,chroma=.765,second=chroma*(1-Math.abs(h%2-1)),m=.1675;
        const rgb=h<1?[chroma,second,0]:h<2?[second,chroma,0]:h<3?[0,chroma,second]:[0,second,chroma];
        const i=(y*720+x)*4;pixels.data.set([...rgb.map(n=>Math.round((n+m)*255)),255],i);
      }
      ctx.putImageData(pixels,0,0);
      if(layer==='wind')for(const p of data.points){if(p.wind===null||p.direction===null)continue;const x=(p.lon+180)*2,y=(90-p.lat)*2;for(const offset of [-720,0,720]){ctx.save();ctx.translate(x+offset,y);ctx.rotate(p.direction*Math.PI/180);ctx.strokeStyle='rgba(255,255,255,.9)';ctx.lineWidth=1.6;ctx.beginPath();ctx.moveTo(0,-6);ctx.lineTo(0,6);ctx.lineTo(-3,2);ctx.moveTo(0,6);ctx.lineTo(3,2);ctx.stroke();ctx.restore();}}
      const provider=await C.SingleTileImageryProvider.fromUrl(canvas.toDataURL(),{rectangle:C.Rectangle.MAX_VALUE,credit:new C.Credit('<a href="https://open-meteo.com/">Weather: Open-Meteo</a>',true)});if(cancelled||!viewer.current)return;const v=viewer.current;if(weatherLayer.current)v.imageryLayers.remove(weatherLayer.current);weatherLayer.current=v.imageryLayers.addImageryProvider(provider);weatherLayer.current.alpha=opacity;v.scene.requestRender();const times=data.points.map(p=>p.time).filter((s):s is string=>!!s).sort();setNote(`模型当前天气 · ${times[0]?new Date(times[0]).toLocaleString():'时间未知'} · 15° 概览网格，非街道实测`);
    }catch{if(!cancelled)setNote('天气暂不可用，请稍后切换图层重试');}}
    void update();const timer=setInterval(update,15*60000);
    return()=>{cancelled=true;abort.abort();clearInterval(timer);const v=viewer.current;if(v&&weatherLayer.current){v.imageryLayers.remove(weatherLayer.current);weatherLayer.current=null;v.scene.requestRender();}};
  },[ready,layer]);
  useEffect(()=>{if(weatherLayer.current)weatherLayer.current.alpha=opacity;viewer.current?.scene.requestRender();},[opacity]);
  const zoom=async(factor:number)=>{const C=await import('cesium'),v=viewer.current;if(!v)return;const p=v.camera.positionCartographic;v.camera.flyTo({destination:C.Cartesian3.fromRadians(p.longitude,p.latitude,Math.max(100,Math.min(50000000,p.height*factor))),duration:.45});};
  return <div className="explorer"><div ref={container} className="explorer-canvas"/><div className="explorer-tools"><label><input type="checkbox" checked={clouds} onChange={e=>setClouds(e.target.checked)}/> 近实时云图</label><select aria-label="天气图层" value={layer} onChange={e=>setLayer(e.target.value as typeof layer)}><option value="none">卫星底图</option><option value="temperature">气温 · °C</option><option value="wind">风速 / 风向 · m/s</option></select>{layer!=='none'&&<label>透明度<input type="range" min="0.1" max="0.9" step="0.05" value={opacity} onChange={e=>setOpacity(+e.target.value)}/></label>}<button onClick={()=>void zoom(.5)} aria-label="放大">＋</button><button onClick={()=>void zoom(2)} aria-label="缩小">－</button><button onClick={()=>{void import('cesium').then(C=>viewer.current?.camera.flyTo({destination:C.Cartesian3.fromDegrees(103.82,1.35,21000000),duration:1.5}));}}>全球</button></div><div className="explorer-info" role="status">{error||(!ready?'加载卫星底图…':`视点高度 ${height} · 滚轮 / 双指连续缩放`)}{clouds&&<div>{cloudNote||'加载云图…'}</div>}{layer!=='none'&&<><div>{note}</div><div className="weather-scale"/><div>{layer==='temperature'?'−30 °C　　0 °C　　45 °C':'0 m/s　　15 m/s　　30+ m/s'}</div></>}{selected&&<div>{selected}</div>}</div></div>;
}
