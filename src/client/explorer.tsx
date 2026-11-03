import {useReferenceLayers} from './use-reference-layers';
import {useWeatherLayers} from './use-weather-layers';
import {useTerrainLayers} from './use-terrain-layers';
import React,{useEffect,useRef,useState} from 'react';
import type {Viewer,ImageryLayer} from 'cesium';
type PointWeather={time:string,sampleLatitude:number,sampleLongitude:number,current:Record<string,number|string|null>,units:Record<string,string>};
export default function Explorer({onExpired,onExit}:{onExpired:()=>void,onExit:()=>void}) {
  const container=useRef<HTMLDivElement>(null), viewer=useRef<Viewer|null>(null);
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[clouds,setClouds]=useState(false),[cloudStrength,setCloudStrength]=useState(.6),[temperature,setTemperature]=useState(false),[wind,setWind]=useState(false),[boundaries,setBoundaries]=useState(false),[labels,setLabels]=useState(false),[opacity,setOpacity]=useState(.55),[cloudNote,setCloudNote]=useState(''),[height,setHeight]=useState(''),[selected,setSelected]=useState('');
  const windLayer=useRef<ImageryLayer|null>(null),weatherLayer=useRef<ImageryLayer|null>(null),cloudLayer=useRef<ImageryLayer|null>(null);
  const [picked,setPicked]=useState<{lat:number,lon:number}|null>(null),[pointWeather,setPointWeather]=useState<PointWeather|null>(null),[pointError,setPointError]=useState(''),[pointLoading,setPointLoading]=useState(false);
  const [elevation,setElevation]=useState(false),[hillshade,setHillshade]=useState(false),[contours,setContours]=useState(false),[terrainOpacity,setTerrainOpacity]=useState(.75),[pointElevation,setPointElevation]=useState<number|null>(null),[elevationError,setElevationError]=useState('');
  const weatherEnabled=clouds||temperature||wind,inspectEnabled=weatherEnabled||elevation||hillshade||contours,weatherEnabledRef=useRef(inspectEnabled),pointSequence=useRef(0);
  weatherEnabledRef.current=inspectEnabled;
  useEffect(()=>{if(!inspectEnabled){setPicked(null);viewer.current?.entities.removeById('weather-point');}},[inspectEnabled]);
  useEffect(()=>{
    if(!picked||!weatherEnabled){setPointWeather(null);setPointError('');setPointLoading(false);return;}const abort=new AbortController(),sequence=++pointSequence.current;
    setPointLoading(true);setPointError('');setPointWeather(null);
    // Brief debounce coalesces successive map clicks before spending quota.
    const timer=setTimeout(()=>{void (async()=>{try{const response=await fetch(`/api/globe/point?v=2&lat=${picked.lat}&lon=${picked.lon}`,{signal:abort.signal});if(response.status===401){onExpired();return;}const data=await response.json();if(!response.ok)throw Error(data.error||'天气数据暂不可用');if(sequence===pointSequence.current)setPointWeather(data);}catch(error){if(!abort.signal.aborted&&sequence===pointSequence.current)setPointError(error instanceof Error?error.message:'天气数据暂不可用');}finally{if(!abort.signal.aborted&&sequence===pointSequence.current)setPointLoading(false);}})();},350);
    return()=>{abort.abort();clearTimeout(timer);};
  },[picked,weatherEnabled]);
  useEffect(()=>{
    setPointElevation(null);setElevationError('');if(!picked)return;let cancelled=false;
    const timer=setTimeout(()=>{const data=terrain.data.current;if(!data)return;void data.point(picked.lat,picked.lon).then(value=>{if(!cancelled)setPointElevation(value);}).catch(error=>{if(!cancelled)setElevationError(error instanceof Error?error.message:'海拔数据暂不可用');});},200);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[picked]);
  useEffect(()=>{let cancelled=false;const frame=requestAnimationFrame(()=>{const v=viewer.current;if(!v)return;v.resize();v.scene.requestRender();if(picked)void import('cesium').then(C=>{if(!cancelled&&!v.isDestroyed())v.camera.flyTo({destination:C.Cartesian3.fromDegrees(picked.lon,picked.lat,v.camera.positionCartographic.height),duration:.5});});});return()=>{cancelled=true;cancelAnimationFrame(frame);};},[picked]);
  const opacityRef=useRef(opacity),cloudStrengthRef=useRef(cloudStrength);opacityRef.current=opacity;cloudStrengthRef.current=cloudStrength;
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
    async function update(){try{const res=await fetch('/api/globe/clouds',{signal:abort.signal});if(res.status===401){onExpired();return;}if(!res.ok)throw Error();const meta=await res.json();const C=await import('cesium');const image=await C.SingleTileImageryProvider.fromUrl(meta.texturePath,{rectangle:C.Rectangle.MAX_VALUE,credit:'Contains modified EUMETSAT data · Live Cloud Maps'});if(cancelled||!viewer.current)return;const v=viewer.current;if(cloudLayer.current)v.imageryLayers.remove(cloudLayer.current);cloudLayer.current=v.imageryLayers.addImageryProvider(image);cloudLayer.current.alpha=cloudStrengthRef.current;restack();setCloudNote(`EUMETSAT · 约 3 小时发布 · ${meta.publishedAt?new Date(meta.publishedAt).toLocaleString():'观测时间未知'}`);}catch{if(!cancelled)setCloudNote('云图刷新失败，已加载的图层保留');}}
    void update();const timer=setInterval(update,15*60000);
    return()=>{cancelled=true;abort.abort();clearInterval(timer);const v=viewer.current;if(v&&cloudLayer.current){v.imageryLayers.remove(cloudLayer.current);cloudLayer.current=null;v.scene.requestRender();}};
  },[ready,clouds]);
  const note=useWeatherLayers(viewer,ready,temperature,wind,opacityRef,weatherLayer,windLayer,restack,onExpired);
  useEffect(()=>{if(weatherLayer.current)weatherLayer.current.alpha=opacity;viewer.current?.scene.requestRender();},[opacity]);
  useEffect(()=>{if(cloudLayer.current)cloudLayer.current.alpha=cloudStrength;viewer.current?.scene.requestRender();},[cloudStrength]);
  const referenceNote=useReferenceLayers(viewer,ready,boundaries,labels);
  const terrain=useTerrainLayers(viewer,ready,{elevation,hillshade,contours},terrainOpacity,onExpired,restack);
  const zoom=async(factor:number)=>{const C=await import('cesium'),v=viewer.current;if(!v)return;const p=v.camera.positionCartographic;v.camera.flyTo({destination:C.Cartesian3.fromRadians(p.longitude,p.latitude,Math.max(100,Math.min(50000000,p.height*factor))),duration:.45});};
  const metric=(key:string,digits=1)=>{const value=pointWeather?.current[key];return typeof value==='number'&&Number.isFinite(value)?value.toFixed(digits):'—';};
  const closePoint=()=>{setPicked(null);viewer.current?.entities.removeById('weather-point');viewer.current?.scene.requestRender();};
  const condition=()=>{const code=Number(pointWeather?.current.weather_code);if(code===0)return '晴';if(code<=3)return ['晴','大部晴朗','局部多云','阴'][code];if(code===45||code===48)return '雾';if(code>=51&&code<=57)return '毛毛雨';if(code>=61&&code<=67)return '雨';if(code>=71&&code<=77)return '雪';if(code>=80&&code<=82)return '阵雨';if(code===85||code===86)return '阵雪';if(code>=95)return '雷暴';return '暂无天气状况';};
  const fields=[['体感温度','apparent_temperature','°C',1],['相对湿度','relative_humidity_2m','%',0],['风速 · 10 m','wind_speed_10m','m/s',1],['风向 · 来向','wind_direction_10m','°',0],['阵风 · 10 m','wind_gusts_10m','m/s',1],['海平面气压','pressure_msl','hPa',1],['降水 · 统计时段','precipitation','mm',1],['总云量','cloud_cover','%',0]] as const;
  return <div className={picked?'explorer explorer--details':'explorer'}><div className="explorer-map">
    <div ref={container} className="explorer-canvas"/>
    <button ref={exitButton} className="explorer-exit" type="button" onClick={onExit} title="返回地球（Esc）">← 返回地球 <kbd>Esc</kbd></button>
    <div className="explorer-tools" role="group" aria-label="叠加图层">
      <details className="explorer-layer-menu"><summary>图层 <span>{[clouds,temperature,wind,boundaries,labels,elevation,hillshade,contours].filter(Boolean).length || ''}</span></summary><div className="explorer-layer-options">
      <div className="layer-section-title">天气</div>
      <label><input type="checkbox" checked={clouds} onChange={e=>setClouds(e.target.checked)}/>近实时云图</label>
      <label><input type="checkbox" checked={temperature} onChange={e=>setTemperature(e.target.checked)}/>空气温度</label>
      <label><input type="checkbox" checked={wind} onChange={e=>setWind(e.target.checked)}/>风速 / 风向</label>
      {clouds&&<label title="只改变显示强弱，不代表云的物理厚度">云层叠加强度<input aria-label="云层叠加强度" type="range" min="0" max="1" step="0.05" value={cloudStrength} onChange={e=>setCloudStrength(+e.target.value)}/><span>{Math.round(cloudStrength*100)}%</span></label>}
      {(temperature||wind)&&<label>天气透明度<input type="range" min="0.1" max="0.9" step="0.05" value={opacity} onChange={e=>setOpacity(+e.target.value)}/></label>}
      <div className="layer-section-title">地形与参考</div>
      <label><input type="checkbox" checked={elevation} onChange={e=>setElevation(e.target.checked)}/>海拔着色</label>
      <label><input type="checkbox" checked={hillshade} onChange={e=>setHillshade(e.target.checked)}/>地形阴影</label>
      <label><input type="checkbox" checked={contours} onChange={e=>setContours(e.target.checked)}/>等高线</label>
      {(elevation||hillshade||contours)&&<label>地形叠加强度<input aria-label="地形叠加强度" type="range" min="0.1" max="1" step="0.05" value={terrainOpacity} onChange={e=>setTerrainOpacity(+e.target.value)}/><span>{Math.round(terrainOpacity*100)}%</span></label>}
      <label><input type="checkbox" checked={boundaries} onChange={e=>setBoundaries(e.target.checked)}/>地理界线</label>
      <label><input type="checkbox" checked={labels} onChange={e=>setLabels(e.target.checked)}/>地名</label>
      <p className="layer-hint">各层可同时开启 · 再点“图层”收起</p>
      </div></details>
      <button onClick={()=>void zoom(.5)} aria-label="放大">＋</button><button onClick={()=>void zoom(2)} aria-label="缩小">－</button>
      <button onClick={()=>{void import('cesium').then(C=>viewer.current?.camera.flyTo({destination:C.Cartesian3.fromDegrees(103.82,1.35,21000000),duration:1.5}));}}>全球</button>
    </div>
    <div className="explorer-info" role="status">
      {error||(!ready?'加载卫星底图…':`视点高度 ${height} · 滚轮 / 双指连续缩放`)}
      {clouds&&<div>{cloudNote||'加载云图…'}</div>}
      {(temperature||wind)&&<><div>{note}</div><div className="weather-scale"/>{temperature&&<div>气温：−40 °C　　5 °C　　50 °C</div>}{wind&&<div>风速{temperature?'（箭头颜色）':''}：0　　15　　30+ m/s · 箭头指向下风向</div>}</>}
      {(boundaries||labels)&&<div>{referenceNote||'参考界线 / 城市地名：Natural Earth'}</div>}
      {(elevation||hillshade||contours)&&<><div>{terrain.error||'Mapzen 地形 · 多源 DEM，精度因区域而异'}</div>{elevation&&<><div className="terrain-scale"/><div>海底　0　500　1,500　3,000　5,000+ m</div></>}{contours&&<div>放大显示等高线 · 等高距 20–500 m · 粗线为 5 倍等高距</div>}{hillshade&&<div>地形阴影为固定光照示意</div>}</>}
      {inspectEnabled&&!picked&&<div>点击地图，查看海拔{weatherEnabled?'与天气':''}详情</div>}{selected&&!picked&&<div>{selected} · WGS84</div>}
    </div></div>
    {picked&&<aside className="weather-details" aria-label="点位详情">
      <header className="weather-details-heading"><div><span className="weather-eyebrow">LOCATION INSIGHTS</span><h2>点位详情</h2></div><button type="button" onClick={closePoint} aria-label="关闭点位详情">×</button></header>
      <p className="weather-coordinates">{Math.abs(picked.lat).toFixed(4)}° {picked.lat>=0?'N':'S'}　{Math.abs(picked.lon).toFixed(4)}° {picked.lon>=0?'E':'W'}</p>
      <section className="point-elevation" aria-label="海拔详情"><span>地形海拔</span><strong>{pointElevation===null?'—':Math.round(pointElevation).toLocaleString()}<small>m</small></strong><p role="status">{elevationError||(pointElevation===null?'正在读取海拔…':pointElevation<0?'低于海平面；海域为海底地形，非水面高度。':'DEM 高程估计；水域不表示水深或实时水位。')}</p><a href="/data/terrain-attribution.html" target="_blank" rel="noreferrer">Mapzen · 数据来源与精度 ↗</a></section>
      <div className="weather-point-status" role="status" aria-live="polite">{pointLoading?'正在获取该点天气…':pointError||(pointWeather?new Date(pointWeather.time).toLocaleString()+' · 模型有效时间':'')}</div>
      {pointWeather&&<><div className="weather-temperature"><span>{metric('temperature_2m')}</span><span>°C</span><p>空气温度 · 地表上方 2 m，非水温</p></div>
        <dl className="weather-metrics">{fields.map(([label,key,unit,digits])=><div key={key}><dt>{label}</dt><dd>{metric(key,digits)}<small>{unit}</small></dd></div>)}</dl>
        <div className="weather-detail-note">天气状况：{condition()}（{metric('weather_code',0)}）<br/>降水统计时段：{typeof pointWeather.current.interval==='number'?pointWeather.current.interval/60:'—'} 分钟<br/>模型取样：{pointWeather.sampleLatitude.toFixed(4)}°, {pointWeather.sampleLongitude.toFixed(4)}°<br/>原生模型气温，未按地形海拔二次修正。非水温，非测站实测。</div>
        <a className="weather-source" href="https://open-meteo.com/" target="_blank" rel="noreferrer">Weather data by Open-Meteo ↗</a></>}
    </aside>}
  </div>;
}
