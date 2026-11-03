import React,{useEffect,useRef,useState} from 'react';
import type {Viewer,ImageryLayer,DataSource} from 'cesium';
type Point={lat:number,lon:number,time:string|null,temperature:number|null,wind:number|null,direction:number|null};
type PointWeather={time:string,sampleLatitude:number,sampleLongitude:number,current:Record<string,number|string|null>,units:Record<string,string>};
type Grid={points:Point[],fetchedAt:string,resolution:number};
export default function Explorer({onExpired,onExit}:{onExpired:()=>void,onExit:()=>void}) {
  const container=useRef<HTMLDivElement>(null), viewer=useRef<Viewer|null>(null);
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[clouds,setClouds]=useState(false),[temperature,setTemperature]=useState(false),[wind,setWind]=useState(false),[boundaries,setBoundaries]=useState(false),[labels,setLabels]=useState(false),[referenceNote,setReferenceNote]=useState(''),[opacity,setOpacity]=useState(.55),[note,setNote]=useState(''),[cloudNote,setCloudNote]=useState(''),[height,setHeight]=useState(''),[selected,setSelected]=useState('');
  const windLayer=useRef<ImageryLayer|null>(null),weatherLayer=useRef<ImageryLayer|null>(null),cloudLayer=useRef<ImageryLayer|null>(null),grid=useRef<Grid|null>(null);
  const boundaryData=useRef<DataSource|null>(null),labelData=useRef<DataSource|null>(null);
  const [picked,setPicked]=useState<{lat:number,lon:number}|null>(null),[pointWeather,setPointWeather]=useState<PointWeather|null>(null),[pointError,setPointError]=useState(''),[pointLoading,setPointLoading]=useState(false);
  const weatherEnabled=clouds||temperature||wind,weatherEnabledRef=useRef(weatherEnabled),pointSequence=useRef(0);
  weatherEnabledRef.current=weatherEnabled;
  useEffect(()=>{if(!weatherEnabled){setPicked(null);viewer.current?.entities.removeById('weather-point');}},[weatherEnabled]);
  useEffect(()=>{
    if(!picked)return;const abort=new AbortController(),sequence=++pointSequence.current;
    setPointLoading(true);setPointError('');setPointWeather(null);
    // Brief debounce coalesces successive map clicks before spending quota.
    const timer=setTimeout(()=>{void (async()=>{try{const response=await fetch(`/api/globe/point?lat=${picked.lat}&lon=${picked.lon}`,{signal:abort.signal});if(response.status===401){onExpired();return;}const data=await response.json();if(!response.ok)throw Error(data.error||'天气数据暂不可用');if(sequence===pointSequence.current)setPointWeather(data);}catch(error){if(!abort.signal.aborted&&sequence===pointSequence.current)setPointError(error instanceof Error?error.message:'天气数据暂不可用');}finally{if(!abort.signal.aborted&&sequence===pointSequence.current)setPointLoading(false);}})();},350);
    return()=>{abort.abort();clearTimeout(timer);};
  },[picked]);
  useEffect(()=>{let cancelled=false;const frame=requestAnimationFrame(()=>{const v=viewer.current;if(!v)return;v.resize();v.scene.requestRender();if(picked)void import('cesium').then(C=>{if(!cancelled&&!v.isDestroyed())v.camera.flyTo({destination:C.Cartesian3.fromDegrees(picked.lon,picked.lat,v.camera.positionCartographic.height),duration:.5});});});return()=>{cancelled=true;cancelAnimationFrame(frame);};},[picked]);
  const gridLoadedAt=useRef(0),opacityRef=useRef(opacity);opacityRef.current=opacity;
  const restack=()=>{const v=viewer.current;if(!v)return;for(const item of [weatherLayer,cloudLayer,windLayer])if(item.current&&v.imageryLayers.contains(item.current))v.imageryLayers.raiseToTop(item.current);v.scene.requestRender();};
  const exitButton=useRef<HTMLButtonElement>(null),exitCallback=useRef(onExit);
  exitCallback.current=onExit;
  useEffect(()=>{
    const previous=document.activeElement;
    exitButton.current?.focus({preventScroll:true});
    const exit=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();exitCallback.current();}};
    window.addEventListener('keydown',exit);
    return()=>{window.removeEventListener('keydown',exit);if(previous instanceof HTMLElement && previous.isConnected)previous.focus({preventScroll:true});};
  },[]);
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
      click.setInputAction((e:{position:import('cesium').Cartesian2})=>{const point=v.camera.pickEllipsoid(e.position,v.scene.globe.ellipsoid);if(!point)return;const cart=C.Cartographic.fromCartesian(point),lat=C.Math.toDegrees(cart.latitude),lon=C.Math.toDegrees(cart.longitude);setSelected(`${lat.toFixed(3)}°, ${lon.toFixed(3)}°`);
        if(weatherEnabledRef.current){setPicked({lat,lon});v.entities.removeById('weather-point');v.entities.add({id:'weather-point',position:point,point:{pixelSize:10,color:C.Color.fromCssColorString('#7dd3fc'),outlineColor:C.Color.WHITE,outlineWidth:2,disableDepthTestDistance:Number.POSITIVE_INFINITY}});v.scene.requestRender();}},C.ScreenSpaceEventType.LEFT_CLICK);
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
    async function update(){try{const res=await fetch('/api/globe/clouds',{signal:abort.signal});if(res.status===401){onExpired();return;}if(!res.ok)throw Error();const meta=await res.json();const C=await import('cesium');const image=await C.SingleTileImageryProvider.fromUrl(meta.texturePath,{rectangle:C.Rectangle.MAX_VALUE,credit:'Contains modified EUMETSAT data · Live Cloud Maps'});if(cancelled||!viewer.current)return;const v=viewer.current;if(cloudLayer.current)v.imageryLayers.remove(cloudLayer.current);cloudLayer.current=v.imageryLayers.addImageryProvider(image);cloudLayer.current.alpha=.6;restack();setCloudNote(`EUMETSAT · 约 3 小时发布 · ${meta.publishedAt?new Date(meta.publishedAt).toLocaleString():'观测时间未知'}`);}catch{if(!cancelled)setCloudNote('云图刷新失败，已加载的图层保留');}}
    void update();const timer=setInterval(update,15*60000);
    return()=>{cancelled=true;abort.abort();clearInterval(timer);const v=viewer.current;if(v&&cloudLayer.current){v.imageryLayers.remove(cloudLayer.current);cloudLayer.current=null;v.scene.requestRender();}};
  },[ready,clouds]);
  useEffect(()=>{
    if(!ready||(!temperature&&!wind))return;let cancelled=false;const abort=new AbortController();setNote('正在读取天气网格…');
    async function update(){try{let data=grid.current;if(!data||Date.now()-gridLoadedAt.current>15*60000){const res=await fetch('/api/globe/weather',{signal:abort.signal});if(res.status===401){onExpired();return;}if(!res.ok)throw Error();data=await res.json() as Grid;gridLoadedAt.current=Date.now();}const C=await import('cesium');if(cancelled||!viewer.current)return;grid.current=data;
      const canvas=document.createElement('canvas');canvas.width=720;canvas.height=360;const ctx=canvas.getContext('2d')!;
      // Bilinear display interpolation improves readability, not source resolution.
      const pixels=ctx.createImageData(720,360), field=temperature?'temperature':'wind';
      for(let y=30;y<330;y++)for(let x=0;x<720;x++){
        const u=x/30,v=(90-y/2+75)/15,lo=Math.floor(v),hi=Math.min(10,lo+1),left=Math.floor(u)%24,right=(left+1)%24;
        const values=[data.points[lo*24+left][field],data.points[lo*24+right][field],data.points[hi*24+left][field],data.points[hi*24+right][field]];
        if(values.some(n=>n===null))continue;const [a,b,c,d]=values as number[],fx=u-Math.floor(u),fy=v-lo,value=(a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+d*fx)*fy;
        const t=Math.max(0,Math.min(1,temperature?(value+30)/75:value/30)),h=(240-240*t)/60,chroma=.765,second=chroma*(1-Math.abs(h%2-1)),m=.1675;
        const rgb=h<1?[chroma,second,0]:h<2?[second,chroma,0]:h<3?[0,chroma,second]:[0,second,chroma];
        const i=(y*720+x)*4;pixels.data.set([...rgb.map(n=>Math.round((n+m)*255)),255],i);
      }
      ctx.putImageData(pixels,0,0);
      const provider=await C.SingleTileImageryProvider.fromUrl(canvas.toDataURL(),{rectangle:C.Rectangle.MAX_VALUE,credit:new C.Credit('<a href="https://open-meteo.com/">Weather: Open-Meteo</a>',true)});if(cancelled||!viewer.current)return;const v=viewer.current;if(weatherLayer.current)v.imageryLayers.remove(weatherLayer.current);weatherLayer.current=v.imageryLayers.addImageryProvider(provider);weatherLayer.current.alpha=opacityRef.current;
      if(windLayer.current){v.imageryLayers.remove(windLayer.current);windLayer.current=null;}
      if(wind){
        const arrows=document.createElement('canvas');arrows.width=1440;arrows.height=720;const pen=arrows.getContext('2d')!;
        for(const p of data.points){if(p.wind===null||p.direction===null)continue;for(const offset of [-1440,0,1440]){pen.save();pen.translate((p.lon+180)*4+offset,(90-p.lat)*4);pen.rotate(p.direction*Math.PI/180);pen.strokeStyle=temperature?`hsl(${240-240*Math.min(1,p.wind/30)},95%,75%)`:'#fff';pen.lineWidth=3;pen.shadowColor='#000';pen.shadowBlur=3;pen.beginPath();pen.moveTo(0,-12);pen.lineTo(0,12);pen.lineTo(-6,4);pen.moveTo(0,12);pen.lineTo(6,4);pen.stroke();pen.restore();}}
        const arrowProvider=await C.SingleTileImageryProvider.fromUrl(arrows.toDataURL(),{rectangle:C.Rectangle.MAX_VALUE});
        if(cancelled||!viewer.current)return;windLayer.current=v.imageryLayers.addImageryProvider(arrowProvider);
      }
      restack();const times=data.points.map(p=>p.time).filter((s):s is string=>!!s).sort();setNote(`模型当前天气 · ${times[0]?new Date(times[0]).toLocaleString():'时间未知'} · 15° 概览网格，非街道实测`);
    }catch{if(!cancelled)setNote('天气暂不可用，请稍后切换图层重试');}}
    void update();const timer=setInterval(update,15*60000);
    return()=>{cancelled=true;abort.abort();clearInterval(timer);const v=viewer.current;if(v&&weatherLayer.current){v.imageryLayers.remove(weatherLayer.current);weatherLayer.current=null;}if(v&&windLayer.current){v.imageryLayers.remove(windLayer.current);windLayer.current=null;}v?.scene.requestRender();};
  },[ready,temperature,wind]);
  useEffect(()=>{if(weatherLayer.current)weatherLayer.current.alpha=opacity;viewer.current?.scene.requestRender();},[opacity]);
  useEffect(()=>{
    if(!ready)return;let cancelled=false;
    async function update(){
      const C=await import('cesium');if(cancelled||!viewer.current)return;const v=viewer.current;
      try {
        // Natural Earth vectors use WGS84, matching satellite/weather coordinates.
        // Never apply GCJ-02/BD-09 offsets to these sources.
        if(boundaries&&!boundaryData.current){
          const data=await C.GeoJsonDataSource.load('/data/boundaries.geojson',{stroke:C.Color.fromCssColorString('#e3edf7'),strokeWidth:1.2,clampToGround:true});
          if(cancelled||v.isDestroyed())return;boundaryData.current=data;await v.dataSources.add(data);
        }
        if(boundaryData.current)boundaryData.current.show=boundaries;
        if(labels&&!labelData.current){
          const response=await fetch('/data/places.json');if(!response.ok)throw Error();const places=await response.json() as {lon:number,lat:number,name:string,rank:number}[];
          if(cancelled||v.isDestroyed())return;const data=new C.CustomDataSource('Natural Earth places');
          for(const p of places)data.entities.add({position:C.Cartesian3.fromDegrees(p.lon,p.lat),label:{text:p.name,font:'13px sans-serif',fillColor:C.Color.WHITE,outlineColor:C.Color.fromCssColorString('#16202e'),outlineWidth:3,style:C.LabelStyle.FILL_AND_OUTLINE,pixelOffset:new C.Cartesian2(0,-8),distanceDisplayCondition:new C.DistanceDisplayCondition(0,p.rank<=1?45000000:p.rank<=3?2000000:p.rank<=5?500000:120000),scaleByDistance:new C.NearFarScalar(50000,1,20000000,.8)}});
          labelData.current=data;await v.dataSources.add(data);
        }
        if(labelData.current)labelData.current.show=labels;
        setReferenceNote('');v.scene.requestRender();
      }catch{if(!cancelled)setReferenceNote('地理参考图层暂不可用');}
    }
    void update();return()=>{cancelled=true;};
  },[ready,boundaries,labels]);
  const zoom=async(factor:number)=>{const C=await import('cesium'),v=viewer.current;if(!v)return;const p=v.camera.positionCartographic;v.camera.flyTo({destination:C.Cartesian3.fromRadians(p.longitude,p.latitude,Math.max(100,Math.min(50000000,p.height*factor))),duration:.45});};
  const metric=(key:string,digits=1)=>{const value=pointWeather?.current[key];return typeof value==='number'&&Number.isFinite(value)?value.toFixed(digits):'—';};
  const closePoint=()=>{setPicked(null);viewer.current?.entities.removeById('weather-point');viewer.current?.scene.requestRender();};
  const condition=()=>{const code=Number(pointWeather?.current.weather_code);if(code===0)return '晴';if(code<=3)return ['晴','大部晴朗','局部多云','阴'][code];if(code===45||code===48)return '雾';if(code>=51&&code<=57)return '毛毛雨';if(code>=61&&code<=67)return '雨';if(code>=71&&code<=77)return '雪';if(code>=80&&code<=82)return '阵雨';if(code===85||code===86)return '阵雪';if(code>=95)return '雷暴';return '暂无天气状况';};
  const fields=[['体感温度','apparent_temperature','°C',1],['相对湿度','relative_humidity_2m','%',0],['风速 · 10 m','wind_speed_10m','m/s',1],['风向 · 来向','wind_direction_10m','°',0],['阵风 · 10 m','wind_gusts_10m','m/s',1],['地面气压','surface_pressure','hPa',1],['降水 · 统计时段','precipitation','mm',1],['总云量','cloud_cover','%',0]] as const;
  return <div className={picked?'explorer explorer--details':'explorer'}><div className="explorer-map">
    <div ref={container} className="explorer-canvas"/>
    <button ref={exitButton} className="explorer-exit" type="button" onClick={onExit} title="返回地球（Esc）">← 返回地球 <kbd>Esc</kbd></button>
    <div className="explorer-tools" role="group" aria-label="叠加图层">
      <label><input type="checkbox" checked={clouds} onChange={e=>setClouds(e.target.checked)}/>近实时云图</label>
      <label><input type="checkbox" checked={temperature} onChange={e=>setTemperature(e.target.checked)}/>气温</label>
      <label><input type="checkbox" checked={wind} onChange={e=>setWind(e.target.checked)}/>风速 / 风向</label>
      <label><input type="checkbox" checked={boundaries} onChange={e=>setBoundaries(e.target.checked)}/>地理界线</label>
      <label><input type="checkbox" checked={labels} onChange={e=>setLabels(e.target.checked)}/>地名</label>
      {(temperature||wind)&&<label>天气透明度<input type="range" min="0.1" max="0.9" step="0.05" value={opacity} onChange={e=>setOpacity(+e.target.value)}/></label>}
      <button onClick={()=>void zoom(.5)} aria-label="放大">＋</button><button onClick={()=>void zoom(2)} aria-label="缩小">－</button>
      <button onClick={()=>{void import('cesium').then(C=>viewer.current?.camera.flyTo({destination:C.Cartesian3.fromDegrees(103.82,1.35,21000000),duration:1.5}));}}>全球</button>
    </div>
    <div className="explorer-info" role="status">
      {error||(!ready?'加载卫星底图…':`视点高度 ${height} · 滚轮 / 双指连续缩放`)}
      {clouds&&<div>{cloudNote||'加载云图…'}</div>}
      {(temperature||wind)&&<><div>{note}</div><div className="weather-scale"/>{temperature&&<div>气温：−30 °C　　0 °C　　45 °C</div>}{wind&&<div>风速{temperature?'（箭头颜色）':''}：0　　15　　30+ m/s · 箭头指向下风向</div>}</>}
      {(boundaries||labels)&&<div>{referenceNote||'参考界线 / 城市地名：Natural Earth'}</div>}
      {weatherEnabled&&!picked&&<div>点击地图，查看该位置的天气详情</div>}{selected&&!picked&&<div>{selected} · WGS84</div>}
    </div></div>
    {picked&&<aside className="weather-details" aria-label="点位天气详情">
      <header className="weather-details-heading"><div><span className="weather-eyebrow">LOCAL WEATHER</span><h2>点位天气</h2></div><button type="button" onClick={closePoint} aria-label="关闭天气详情">×</button></header>
      <p className="weather-coordinates">{Math.abs(picked.lat).toFixed(4)}° {picked.lat>=0?'N':'S'}　{Math.abs(picked.lon).toFixed(4)}° {picked.lon>=0?'E':'W'}</p>
      <div className="weather-point-status" role="status" aria-live="polite">{pointLoading?'正在获取该点天气…':pointError||(pointWeather?new Date(pointWeather.time).toLocaleString()+' · 模型有效时间':'')}</div>
      {pointWeather&&<><div className="weather-temperature"><span>{metric('temperature_2m')}</span><span>°C</span><p>气温 · 离地 2 m</p></div>
        <dl className="weather-metrics">{fields.map(([label,key,unit,digits])=><div key={key}><dt>{label}</dt><dd>{metric(key,digits)}<small>{unit}</small></dd></div>)}</dl>
        <div className="weather-detail-note">天气状况：{condition()}（{metric('weather_code',0)}）<br/>降水统计时段：{typeof pointWeather.current.interval==='number'?pointWeather.current.interval/60:'—'} 分钟<br/>模型取样：{pointWeather.sampleLatitude.toFixed(4)}°, {pointWeather.sampleLongitude.toFixed(4)}°<br/>模型估计，非现场测站实测。不同地区模型精度不同。</div>
        <a className="weather-source" href="https://open-meteo.com/" target="_blank" rel="noreferrer">Weather data by Open-Meteo ↗</a></>}
    </aside>}
  </div>;
}
