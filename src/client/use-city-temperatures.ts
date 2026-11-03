import {useEffect,useRef,useState} from 'react';
import {weatherLocation,POINT_WEATHER_TTL,type PointWeather,type NativeWeatherPoint} from '../weather-point';
export function useCityTemperatures(places:{lat:number;lon:number}[],enabled:boolean,onExpired:()=>void,selected?:NativeWeatherPoint|null){
 const cache=useRef(new Map<string,PointWeather>()),expired=useRef(onExpired),last=useRef(0);expired.current=onExpired;
 const [revision,setRevision]=useState(0),[note,setNote]=useState('');
 const put=(p:NativeWeatherPoint)=>{const key=weatherLocation(p.lat,p.lon)?.key;if(!key)return;const old=cache.current.get(key);if(old&&Date.parse(old.fetchedAt)>Date.parse(p.weather.fetchedAt))return;cache.current.delete(key);cache.current.set(key,p.weather);while(cache.current.size>512)cache.current.delete(cache.current.keys().next().value!);};
 useEffect(()=>{if(selected){put(selected);setRevision(n=>n+1);}},[selected]);
 const keys=[...new Map(places.map(p=>{const v=weatherLocation(p.lat,p.lon)!;return [v.key,{lat:v.lat,lon:v.lon}];})).values()].map(p=>p.lat+','+p.lon).sort().join(';');
 useEffect(()=>{if(!enabled||!keys)return;let stopped=false,running=false;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>,retry:ReturnType<typeof setTimeout>|undefined;
  const update=async()=>{if(stopped||running)return;const points=keys.split(';').map(s=>{const [lat,lon]=s.split(',').map(Number);return weatherLocation(lat,lon)!;}).filter(p=>{const hit=cache.current.get(p.key);return !hit||Date.now()-Date.parse(hit.fetchedAt)>=POINT_WEATHER_TTL;});if(!points.length)return;last.current=Date.now();running=true;
   try{for(let i=0;i<points.length;i+=24){if(stopped)return;const group=points.slice(i,i+24);const r=await fetch('/api/globe/city-points?'+new URLSearchParams({points:group.map(p=>p.lat+','+p.lon).join(';')}),{signal:abort.signal,cache:'no-store'});if(r.status===401){expired.current();return;}if(!r.ok)throw Error(r.status===429?'城市气温更新稍快，稍后自动重试':'部分城市气温暂不可用，稍后自动重试');const data=await r.json() as {points:NativeWeatherPoint[];pending:boolean};if(stopped)return;for(const p of data.points)put(p);setRevision(n=>n+1);setNote('');if(data.pending){retry=setTimeout(()=>void update(),5000);return;}}
   }catch(e){if(!stopped&&!abort.signal.aborted){setNote(e instanceof Error?e.message:'城市气温暂不可用');retry=setTimeout(()=>void update(),60000);}}finally{running=false;}
  };
  timer=setTimeout(()=>void update(),Math.max(700,5000-(Date.now()-last.current)));const interval=setInterval(()=>{setRevision(n=>n+1);void update();},60000);
  return()=>{stopped=true;abort.abort();clearTimeout(timer);clearTimeout(retry);clearInterval(interval);};
 },[enabled,keys]);
 const at=(p:{lat:number;lon:number})=>{const key=weatherLocation(p.lat,p.lon)?.key,hit=key?cache.current.get(key):undefined;return hit&&Date.now()-Date.parse(hit.fetchedAt)<POINT_WEATHER_TTL?hit:undefined;};
 return {at,note,revision};
}
