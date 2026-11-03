import {useSatellite} from './use-satellite';
import type {SatelliteMode} from '../satellite';
import {PointLocation} from './point-location';
import type {PlaceDensity} from '../city-visibility';
import {CityWeather} from './city-weather';
import {useRadar} from './use-radar';
import {weatherFields,fieldGradient,type WeatherField} from './weather-palettes';
import {PlaceSearch} from './place-search';
import {useReferenceLayers} from './use-reference-layers';
import {useWeatherLayers} from './use-weather-layers';
import {useTerrainLayers} from './use-terrain-layers';
import React,{useEffect,useRef,useState} from 'react';
import type {Viewer,ImageryLayer} from 'cesium';
type PointWeather={time:string,sampleLatitude:number,sampleLongitude:number,current:Record<string,number|string|null>,units:Record<string,string>};
export default function Explorer({onExpired,onExit,onLogout}:{onExpired:()=>void,onExit:()=>void,onLogout?:()=>void}) {
  const container=useRef<HTMLDivElement>(null), viewer=useRef<Viewer|null>(null);
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[clouds,setClouds]=useState(false),[cloudStrength,setCloudStrength]=useState(.6),[temperature,setTemperature]=useState(true),[wind,setWind]=useState(false),[boundaries,setBoundaries]=useState(true),[labels,setLabels]=useState(false),[opacity,setOpacity]=useState(.78),[cloudNote,setCloudNote]=useState(''),[height,setHeight]=useState(''),[selected,setSelected]=useState('');
  const [field,setField]=useState<WeatherField>('temperature'),[radarEnabled,setRadarEnabled]=useState(false),[citiesEnabled,setCitiesEnabled]=useState(true),[flat,setFlat]=useState(false),[baseMap,setBaseMap]=useState<'satellite'|'map'|'recent'>('satellite'),[baseNote,setBaseNote]=useState('');
  const [placeDensity,setPlaceDensity]=useState<PlaceDensity>(()=>{try{const value=localStorage.getItem('ionize-place-density');if(value==='major'||value==='standard'||value==='detailed')return value;}catch{}return 'detailed';});
  useEffect(()=>{try{localStorage.setItem('ionize-place-density',placeDensity);}catch{}},[placeDensity]);
  const baseLayer=useRef<ImageryLayer|null>(null),baseCache=useRef<Partial<Record<'satellite'|'map',ImageryLayer>>>({});
  const [satelliteMode,setSatelliteMode]=useState<SatelliteMode>('latest');
  const radar=useRadar(viewer,ready,radarEnabled);
  const choose=(value:WeatherField|'wind'|'radar'|'satellite')=>{setTemperature(value!=='wind'&&value!=='radar'&&value!=='satellite');setWind(value==='wind');setRadarEnabled(value==='radar');setClouds(value==='satellite');if(value!=='wind'&&value!=='radar'&&value!=='satellite')setField(value);};
  const pickCity=(p:{lat:number;lon:number})=>{setPicked(p);void import('cesium').then(C=>{const v=viewer.current;if(!v)return;v.entities.removeById('weather-point');v.entities.add({id:'weather-point',position:C.Cartesian3.fromDegrees(p.lon,p.lat),point:{pixelSize:10,color:C.Color.fromCssColorString('#7dd3fc'),outlineColor:C.Color.WHITE,outlineWidth:2}});v.camera.cancelFlight();v.camera.flyTo({destination:C.Cartesian3.fromDegrees(p.lon,p.lat,Math.min(160000,v.camera.positionCartographic.height)),duration:1});});};
  const windLayer=useRef<ImageryLayer|null>(null),weatherLayer=useRef<ImageryLayer|null>(null),cloudLayer=useRef<ImageryLayer|null>(null);
  const [picked,setPicked]=useState<{lat:number,lon:number}|null>(null),[pointWeather,setPointWeather]=useState<PointWeather|null>(null),[pointError,setPointError]=useState(''),[pointLoading,setPointLoading]=useState(false);
  const [elevation,setElevation]=useState(false),[hillshade,setHillshade]=useState(false),[contours,setContours]=useState(false),[terrainOpacity,setTerrainOpacity]=useState(.75),[pointElevation,setPointElevation]=useState<number|null>(null),[elevationError,setElevationError]=useState('');
  const weatherEnabled=clouds||temperature||wind||radarEnabled||citiesEnabled,inspectEnabled=weatherEnabled||elevation||hillshade||contours||baseMap==='recent',weatherEnabledRef=useRef(inspectEnabled),pointSequence=useRef(0);
  weatherEnabledRef.current=inspectEnabled;
  useEffect(()=>{if(!inspectEnabled){setPicked(null);viewer.current?.entities.removeById('weather-point');}},[inspectEnabled]);
  useEffect(()=>{
    if(!picked||!weatherEnabled){setPointWeather(null);setPointError('');setPointLoading(false);return;}const abort=new AbortController(),sequence=++pointSequence.current;
    setPointLoading(true);setPointError('');setPointWeather(null);
    // Brief debounce coalesces successive map clicks before spending quota.
    const timer=setTimeout(()=>{void (async()=>{try{const response=await fetch(`/api/globe/point?v=2&lat=${picked.lat}&lon=${picked.lon}`,{signal:abort.signal});if(response.status===401){onExpired();return;}const data=await response.json().catch(()=>({error:'天气服务暂不可用，请稍后重试'}));if(!response.ok)throw Error(data.error||'天气数据暂不可用');if(sequence===pointSequence.current)setPointWeather(data);}catch(error){if(!abort.signal.aborted&&sequence===pointSequence.current)setPointError(error instanceof Error?error.message:'天气数据暂不可用');}finally{if(!abort.signal.aborted&&sequence===pointSequence.current)setPointLoading(false);}})();},350);
    return()=>{abort.abort();clearTimeout(timer);};
  },[picked,weatherEnabled]);
  useEffect(()=>{
    setPointElevation(null);setElevationError('');if(!picked)return;let cancelled=false;
    const timer=setTimeout(()=>{const data=terrain.data.current;if(!data)return;void data.point(picked.lat,picked.lon).then(value=>{if(!cancelled)setPointElevation(value);}).catch(error=>{if(!cancelled)setElevationError(error instanceof Error?error.message:'海拔数据暂不可用');});},200);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[picked]);
  useEffect(()=>{const frame=requestAnimationFrame(()=>{viewer.current?.resize();viewer.current?.scene.requestRender();});return()=>cancelAnimationFrame(frame);},[picked]);
  const opacityRef=useRef(opacity),cloudStrengthRef=useRef(cloudStrength);opacityRef.current=opacity;cloudStrengthRef.current=cloudStrength;
  const restack=()=>{const v=viewer.current;if(!v)return;for(const item of [weatherLayer,cloudLayer,windLayer,terrain.layer])if(item.current&&v.imageryLayers.contains(item.current))v.imageryLayers.raiseToTop(item.current);v.scene.requestRender();};
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
      v.useBrowserRecommendedResolution=false;v.resolutionScale=Math.min(2,window.devicePixelRatio||1)/(window.devicePixelRatio||1);
      v.scene.screenSpaceCameraController.minimumZoomDistance=100;
      v.scene.screenSpaceCameraController.maximumZoomDistance=50000000;
      v.scene.globe.maximumScreenSpaceError=2;
      v.camera.setView({destination:C.Cartesian3.fromDegrees(103.82,1.35,21000000)});
      try{const saved=JSON.parse(sessionStorage.getItem('ionize-explore-camera')||'null');if(saved&&[saved.lon,saved.lat,saved.height].every(Number.isFinite))v.camera.setView({destination:C.Cartesian3.fromDegrees(saved.lon,saved.lat,Math.max(100,Math.min(50000000,saved.height)))});}catch{}
      const move=()=>{const p=v.camera.positionCartographic;setHeight(p.height>1000?`${(p.height/1000).toFixed(1)} km`:`${p.height.toFixed(0)} m`);try{sessionStorage.setItem('ionize-explore-camera',JSON.stringify({lon:C.Math.toDegrees(p.longitude),lat:C.Math.toDegrees(p.latitude),height:p.height}));}catch{}};
      const remove=v.camera.moveEnd.addEventListener(move);move();
      const click=new C.ScreenSpaceEventHandler(v.scene.canvas);
      click.setInputAction((e:{position:import('cesium').Cartesian2})=>{const point=v.camera.pickEllipsoid(e.position,v.scene.globe.ellipsoid);if(!point)return;const cart=C.Cartographic.fromCartesian(point),lat=C.Math.toDegrees(cart.latitude),lon=C.Math.toDegrees(cart.longitude);setSelected(`${lat.toFixed(3)}°, ${lon.toFixed(3)}°`);
        if(weatherEnabledRef.current){setPicked({lat,lon});const height=v.camera.positionCartographic.height;requestAnimationFrame(()=>{if(!v.isDestroyed()){v.resize();v.camera.flyTo({destination:C.Cartesian3.fromDegrees(lon,lat,height),duration:.5});}});v.entities.removeById('weather-point');v.entities.add({id:'weather-point',position:point,point:{pixelSize:10,color:C.Color.fromCssColorString('#7dd3fc'),outlineColor:C.Color.WHITE,outlineWidth:2,disableDepthTestDistance:Number.POSITIVE_INFINITY}});v.scene.requestRender();}},C.ScreenSpaceEventType.LEFT_CLICK);
      cleanup=()=>{remove();click.destroy();v.destroy();viewer.current=null;};
      try {
        const imagery=await C.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',{enablePickFeatures:false,maximumLevel:19});
        if(cancelled)return;baseLayer.current=v.imageryLayers.addImageryProvider(imagery);baseCache.current.satellite=baseLayer.current;v.scene.requestRender();setReady(true);
      }catch{if(!cancelled)setError('卫星底图暂不可用，请稍后重新进入。');}
    })().catch(()=>{if(!cancelled)setError('当前设备无法启动地图，请尝试支持 WebGL 的浏览器。');});
    return()=>{cancelled=true;cleanup?.();css.remove();};
  },[]);
  useEffect(()=>{
    const v=viewer.current;if(!ready||!v)return;let stopped=false;setBaseNote('');
    void (async()=>{const baseKind=baseMap==='recent'?'satellite':baseMap;let layer=baseCache.current[baseKind];if(!layer){const C=await import('cesium');if(stopped||v.isDestroyed())return;const provider=new C.UrlTemplateImageryProvider({url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',maximumLevel:19,enablePickFeatures:false,credit:new C.Credit('<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',true)});provider.errorEvent.addEventListener(()=>{if(!stopped)setBaseNote('部分地图瓦片暂不可用，可切换卫星影像');});layer=v.imageryLayers.addImageryProvider(provider,0);baseCache.current.map=layer;}if(stopped)return;for(const [key,item] of Object.entries(baseCache.current))if(item){item.show=key===baseKind;item.saturation=baseMap==='recent'?.15:1;item.brightness=baseMap==='recent'?.6:1;}baseLayer.current=layer;v.imageryLayers.lowerToBottom(layer);v.scene.requestRender();})().catch(()=>{if(!stopped)setBaseNote('底图切换失败，请稍后重试');});return()=>{stopped=true;};
  },[ready,baseMap]);
  useEffect(()=>{
    if(!ready||!clouds)return;let cancelled=false;const abort=new AbortController();
    async function update(){try{const res=await fetch('/api/globe/clouds',{signal:abort.signal});if(res.status===401){onExpired();return;}if(!res.ok)throw Error();const meta=await res.json();const C=await import('cesium');const image=await C.SingleTileImageryProvider.fromUrl(meta.texturePath,{rectangle:C.Rectangle.MAX_VALUE,credit:'Contains modified EUMETSAT data · Live Cloud Maps'});if(cancelled||!viewer.current)return;const v=viewer.current;if(cloudLayer.current)v.imageryLayers.remove(cloudLayer.current);cloudLayer.current=v.imageryLayers.addImageryProvider(image);cloudLayer.current.alpha=cloudStrengthRef.current;restack();setCloudNote(`EUMETSAT · 约 3 小时发布 · ${meta.publishedAt?new Date(meta.publishedAt).toLocaleString():'观测时间未知'}`);}catch{if(!cancelled)setCloudNote('云图刷新失败，已加载的图层保留');}}
    void update();const timer=setInterval(update,15*60000);
    return()=>{cancelled=true;abort.abort();clearInterval(timer);const v=viewer.current;if(v&&cloudLayer.current){v.imageryLayers.remove(cloudLayer.current);cloudLayer.current=null;v.scene.requestRender();}};
  },[ready,clouds]);
  const {note,samples}=useWeatherLayers(viewer,ready,temperature,wind,opacityRef,weatherLayer,windLayer,restack,onExpired,field,citiesEnabled);
  useEffect(()=>{if(weatherLayer.current)weatherLayer.current.alpha=opacity;viewer.current?.scene.requestRender();},[opacity]);
  useEffect(()=>{if(cloudLayer.current)cloudLayer.current.alpha=cloudStrength;viewer.current?.scene.requestRender();},[cloudStrength]);
  const referenceNote=useReferenceLayers(viewer,ready,boundaries,labels);
  const terrain=useTerrainLayers(viewer,ready,{elevation,hillshade,contours},terrainOpacity,onExpired,restack);
  const recent=useSatellite(viewer,ready,baseMap==='recent',satelliteMode,onExpired,restack);
  const zoom=async(factor:number)=>{const C=await import('cesium'),v=viewer.current;if(!v)return;const p=v.camera.positionCartographic;v.camera.flyTo({destination:C.Cartesian3.fromRadians(p.longitude,p.latitude,Math.max(100,Math.min(50000000,p.height*factor))),duration:.45});};
  const metric=(key:string,digits=1)=>{const value=pointWeather?.current[key];return typeof value==='number'&&Number.isFinite(value)?value.toFixed(digits):'—';};
  const closePoint=()=>{setPicked(null);viewer.current?.entities.removeById('weather-point');viewer.current?.scene.requestRender();};
  const condition=()=>{const code=Number(pointWeather?.current.weather_code);if(code===0)return '晴';if(code<=3)return ['晴','大部晴朗','局部多云','阴'][code];if(code===45||code===48)return '雾';if(code>=51&&code<=57)return '毛毛雨';if(code>=61&&code<=67)return '雨';if(code>=71&&code<=77)return '雪';if(code>=80&&code<=82)return '阵雨';if(code===85||code===86)return '阵雪';if(code>=95)return '雷暴';return '暂无天气状况';};
  const fields=[['体感温度','apparent_temperature','°C',1],['相对湿度','relative_humidity_2m','%',0],['风速 · 10 m','wind_speed_10m','m/s',1],['风向 · 来向','wind_direction_10m','°',0],['阵风 · 10 m','wind_gusts_10m','m/s',1],['海平面气压','pressure_msl','hPa',1],['降水 · 统计时段','precipitation','mm',1],['总云量','cloud_cover','%',0]] as const;
  return <div className={picked?'explorer explorer--details':'explorer'}><div className="explorer-map">
    <div ref={container} className="explorer-canvas"/>
    <CityWeather density={placeDensity} samples={samples} viewer={viewer} ready={ready} enabled={citiesEnabled||labels} showTemperature={citiesEnabled} onPick={pickCity} onExpired={onExpired}/>
    <PlaceSearch onExpired={onExpired} onPick={p=>{setPicked(p);setSelected(p.name);void import('cesium').then(C=>{const v=viewer.current;if(!v)return;v.entities.removeById('weather-point');v.entities.add({id:'weather-point',position:C.Cartesian3.fromDegrees(p.lon,p.lat),point:{pixelSize:12,color:C.Color.fromCssColorString('#7dd3fc'),outlineColor:C.Color.WHITE,outlineWidth:2}});const height=p.kind==='country'||p.kind==='ocean'?6000000:p.kind==='state'?2000000:p.kind==='city'?160000:p.kind==='coordinate'?30000:6000;v.camera.cancelFlight();v.camera.flyTo({destination:C.Cartesian3.fromDegrees(p.lon,p.lat,height),duration:1.2});});}}/>
    <nav className="weather-dock" aria-label="天气图层快速切换">{(['temperature','wind','radar','satellite','humidity','pressure','cloud'] as const).map((value,i)=><button key={value} aria-pressed={value==='wind'?wind:value==='radar'?radarEnabled:value==='satellite'?clouds:temperature&&field===value} onClick={()=>choose(value)}><span>{['◉','≋','◌','☁','◒','◎','◐'][i]}</span>{value==='wind'?'风场':value==='radar'?'雷达':value==='satellite'?'卫星云图':weatherFields[value].label}</button>)}</nav>
    {radarEnabled&&<section className="radar-timeline" aria-label="雷达历史回放"><div><button disabled={radar.frames.length<2} onClick={()=>radar.setPlaying(!radar.playing)} aria-label={radar.playing?'暂停雷达回放':'播放雷达历史'}>{radar.playing?'Ⅱ':'▶'}</button><strong>降水雷达</strong><time>{radar.frames[radar.index]?new Date(radar.frames[radar.index].time*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'加载中…'}</time><span>过去 2 小时</span></div><input aria-label="雷达历史时间" type="range" min="0" max={Math.max(0,radar.frames.length-1)} value={radar.index} disabled={!radar.frames.length} onChange={e=>{radar.setPlaying(false);radar.setIndex(+e.target.value);}}/><p>{radar.error||'帧生成时间 · 每 10 分钟一帧 · 回放每 10 秒前进一帧'}<br/>覆盖因地区而异，空白不代表无降水 · <a href="https://www.rainviewer.com/" target="_blank" rel="noreferrer">RainViewer ↗</a></p></section>}
    <button ref={exitButton} className="explorer-exit" type="button" onClick={onExit} title="返回地球（Esc）">← 返回地球 <kbd>Esc</kbd></button>
    {onLogout&&<button className="explorer-logout" type="button" onClick={onLogout}>退出登录</button>}
    <div className="explorer-tools" role="group" aria-label="叠加图层">
      <details className="explorer-layer-menu"><summary>图层 <span>{[clouds,temperature,wind,radarEnabled,citiesEnabled,boundaries,labels,elevation,hillshade,contours].filter(Boolean).length || ''}</span></summary><div className="explorer-layer-options">
      <div className="layer-section-title">天气显示</div><label><input type="checkbox" checked={citiesEnabled} onChange={e=>setCitiesEnabled(e.target.checked)}/>主要城市气温</label>
      <label><input type="checkbox" checked={clouds} onChange={e=>setClouds(e.target.checked)}/>近实时云图</label>
      <label><input type="checkbox" checked={temperature} onChange={e=>{setField('temperature');setTemperature(e.target.checked);setRadarEnabled(false);}}/>空气温度</label>
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
      <label>地名密度<select aria-label="地名密度" value={placeDensity} onChange={e=>{setPlaceDensity(e.target.value as PlaceDensity);setLabels(true);}}><option value="major">主要城市</option><option value="standard">标准</option><option value="detailed">详细</option></select></label>
      <p className="layer-hint">详细模式显示更多已有地名，自动避让重叠。</p>
      <p className="layer-hint">各层可同时开启 · 再点“图层”收起</p>
      </div></details>
      <select aria-label="地图底图" value={baseMap} onChange={e=>{const value=e.target.value as 'satellite'|'map'|'recent';setBaseMap(value);if(value==='recent'){setTemperature(false);setWind(false);setClouds(false);setRadarEnabled(false);}}}><option value="satellite">卫星影像</option><option value="map">简洁地图</option><option value="recent">近期卫星 · CDSE</option></select>
      <button aria-pressed={flat} onClick={()=>{void import('cesium').then(C=>{const v=viewer.current;if(!v)return;const p=v.camera.positionCartographic;const destination=C.Cartesian3.fromRadians(p.longitude,p.latitude,p.height);const remove=v.scene.morphComplete.addEventListener(()=>{remove();if(!v.isDestroyed()){v.camera.setView({destination});v.scene.requestRender();}});if(flat)v.scene.morphTo3D(.8);else v.scene.morphTo2D(.8);setFlat(!flat);});}}>{flat?'3D 地球':'2D 地图'}</button>
      <button onClick={()=>void zoom(.5)} aria-label="放大">＋</button><button onClick={()=>void zoom(2)} aria-label="缩小">－</button>
      <button onClick={()=>{void import('cesium').then(C=>viewer.current?.camera.flyTo({destination:C.Cartesian3.fromDegrees(103.82,1.35,21000000),duration:1.5}));}}>全球</button>
    </div>
    {baseMap==='recent'&&<section className="satellite-panel" aria-label="近期卫星影像"><div><strong>近期卫星影像</strong><select aria-label="卫星影像选择" value={satelliteMode} onChange={e=>setSatelliteMode(e.target.value as SatelliteMode)}><option value="latest">最新优先</option><option value="clear">少云优先 · 近30天</option></select><button type="button" onClick={recent.refresh} disabled={recent.state.status==='loading'}>重新加载</button></div>{recent.state.scene&&recent.state.status==='ready'?<><p>拍摄时间：{new Date(recent.state.scene.acquiredAt).toLocaleString()}<br/>整景云量：{recent.state.scene.cloudCover===null?'未知':recent.state.scene.cloudCover.toFixed(1)+'%'} · 显示采样约 {recent.state.scene.resolutionMeters} m</p><p>Sentinel‑2 原始彩色波段 10 m · 优先选择视野中心影像。暗色区域为参考底图，可能没有本次拍摄覆盖。非连续直播。</p></>:<p role="status">{recent.state.message}</p>}<a href="/data/satellite-attribution.html" target="_blank" rel="noreferrer">CDSE · 拍摄时间、覆盖与缓存说明 ↗</a></section>}
    <div className={radarEnabled?"explorer-info explorer-info--radar":"explorer-info"} role="status">
      {error||(!ready?'加载卫星底图…':`视点高度 ${height} · 滚轮 / 双指连续缩放`)}
      {baseNote&&<div>{baseNote}</div>}
      {clouds&&<div>{cloudNote||'加载云图…'}</div>}
      {(temperature||wind)&&<><div>{note}</div>{temperature&&<div className="weather-legend"><strong>{weatherFields[field].label} <small>{weatherFields[field].unit}</small></strong><div className="weather-scale" style={{background:fieldGradient(field)}}/><div className="weather-ticks">{weatherFields[field].ticks.map(t=><span key={t}>{t}</span>)}</div></div>}{wind&&<div className="weather-legend"><strong>风速 <small>m/s · 箭头指向下风向</small></strong><div className="weather-scale"/><div className="weather-ticks"><span>0</span><span>10</span><span>20</span><span>30+</span></div></div>}</>}
      <a className="weather-data-link" href="/data/weather-attribution.html" target="_blank" rel="noreferrer">数据来源、精度与更新频率 ↗</a>
      {citiesEnabled&&<div>城市气温 · Open-Meteo · 地名：Natural Earth / GeoNames · 点击查看详情</div>}
      {(boundaries||labels)&&<div>{referenceNote||'界线：Natural Earth · 地名：Natural Earth / GeoNames'}</div>}
      {(elevation||hillshade||contours)&&<><div>{terrain.error||'Mapzen 地形 · 多源 DEM，精度因区域而异'}</div>{elevation&&<><div className="terrain-scale"/><div>海底　0　500　1,500　3,000　5,000+ m</div></>}{contours&&<div>放大显示等高线 · 等高距 20–500 m · 粗线为 5 倍等高距</div>}{hillshade&&<div>地形阴影为固定光照示意</div>}</>}
      {inspectEnabled&&!picked&&<div>点击地图，查看海拔{weatherEnabled?'与天气':''}详情</div>}{selected&&!picked&&<div>{selected} · WGS84</div>}
    </div></div>
    {picked&&<aside className="weather-details" aria-label="点位详情">
      <header className="weather-details-heading"><div><span className="weather-eyebrow">LOCATION INSIGHTS</span><h2>点位详情</h2></div><button type="button" onClick={closePoint} aria-label="关闭点位详情">×</button></header>
      <p className="weather-coordinates">{Math.abs(picked.lat).toFixed(4)}° {picked.lat>=0?'N':'S'}　{Math.abs(picked.lon).toFixed(4)}° {picked.lon>=0?'E':'W'}</p>
      <PointLocation lat={picked.lat} lon={picked.lon} onExpired={onExpired}/>
      <section className="point-elevation" aria-label="海拔详情"><span>地形海拔</span><strong>{pointElevation===null?'—':Math.round(pointElevation).toLocaleString()}<small>m</small></strong><p role="status">{elevationError||(pointElevation===null?'正在读取海拔…':pointElevation<0?'低于海平面；海域为海底地形，非水面高度。':'DEM 高程估计；水域不表示水深或实时水位。')}</p><a href="/data/terrain-attribution.html" target="_blank" rel="noreferrer">Mapzen · 数据来源与精度 ↗</a></section>
      <div className="weather-point-status" role="status" aria-live="polite">{pointLoading?'正在获取该点天气…':pointError||(pointWeather?new Date(pointWeather.time).toLocaleString()+' · 模型有效时间':'')}</div>
      {pointWeather&&<><div className="weather-temperature"><span>{metric('temperature_2m')}</span><span>°C</span><p>空气温度 · 地表上方 2 m，非水温</p></div>
        <dl className="weather-metrics">{fields.map(([label,key,unit,digits])=><div key={key}><dt>{label}</dt><dd>{metric(key,digits)}<small>{unit}</small></dd></div>)}</dl>
        <div className="weather-detail-note">天气状况：{condition()}（{metric('weather_code',0)}）<br/>降水统计时段：{typeof pointWeather.current.interval==='number'?pointWeather.current.interval/60:'—'} 分钟<br/>模型取样：{pointWeather.sampleLatitude.toFixed(4)}°, {pointWeather.sampleLongitude.toFixed(4)}°<br/>原生模型气温，未按地形海拔二次修正。非水温，非测站实测。</div>
        <a className="weather-source" href="https://open-meteo.com/" target="_blank" rel="noreferrer">Weather data by Open-Meteo ↗</a></>}
    </aside>}
  </div>;
}
