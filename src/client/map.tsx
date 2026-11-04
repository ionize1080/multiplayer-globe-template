import './styles.css';
import React,{lazy,Suspense,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
const Explorer=lazy(()=>import('./explorer'));
function MapApp(){
 const [user,setUser]=useState<{email:string}|null>(null),[checked,setChecked]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{document.title='IONIZE MAP · 探索地球';document.documentElement.lang='zh-CN';document.querySelector('meta[name="description"]')?.setAttribute('content','全球天气、自然彩色卫星影像、地形等高线与地点搜索。');let active=true;const controller=new AbortController();
  const check=async()=>{try{const r=await fetch('/api/globe/me',{cache:'no-store',signal:controller.signal});if(!r.ok)throw Error();const d=await r.json();if(active){setUser(d.user);setChecked(true);setError('');}}catch{if(active){setError('暂时无法检查登录状态，请重试');setChecked(true);}}};
  void check();const timer=setInterval(check,60000);window.addEventListener('focus',check);return()=>{active=false;controller.abort();clearInterval(timer);window.removeEventListener('focus',check);};
 },[retry]);
 const logout=async()=>{try{const r=await fetch('/api/globe/logout',{method:'POST'});if(!r.ok)throw Error();setUser(null);setError('');}catch{setError('退出登录失败，请稍后重试');}};
 if(user)return <div className="page--explore map-standalone"><Suspense fallback={<div className="explorer-loading">正在加载探索地图…</div>}><Explorer onExit={()=>location.assign('https://ionize.club/')} onExpired={()=>{setUser(null);setError('登录已过期，请重新登录');}} onLogout={()=>void logout()}/></Suspense>{error&&<div className="map-session-note" role="status">{error}</div>}</div>;
 return <main className="map-welcome"><div className="map-welcome-orbit" aria-hidden="true"/><section><a className="map-brand" href="https://ionize.club/">IONIZE <span>MAP</span></a><p className="map-eyebrow">EXPLORE OUR PLANET</p><h1>地球的每一处，<br/>都值得探索。</h1><p className="map-intro">从实时天气到动植物的观察记录，<br/>重访卫星影像，认识物种，探索身边与远方。</p><div className="map-features"><span>全球地点搜索</span><span>天气与雷达</span><span>地形等高线</span><span>动植物图谱</span><span>物种统计</span><span>卫星时间动画</span></div>{!checked?<p role="status">正在检查登录状态…</p>:<><a className="map-login" href="/auth/login">使用 IONACS 邮箱登录 <span>↗</span></a>{error&&<p className="map-login-error" role="status">{error} <button onClick={()=>{setChecked(false);setRetry(n=>n+1);}}>重试</button></p>}<p className="map-login-note">使用现有账户，登录后直接进入探索地图。</p></>}<a className="map-back" href="https://ionize.club/">← 返回 ionize.club</a></section></main>;
}
createRoot(document.getElementById('root')!).render(<MapApp/>);
