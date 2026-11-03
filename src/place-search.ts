export type PlaceResult={id:string;name:string;detail:string;lat:number;lon:number;kind:string};
export const normalizeQuery=(q:string)=>q.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
/** Unlabelled pairs are latitude, longitude. Cardinal directions permit either order. */
export function parseCoordinates(input:string):{lat:number;lon:number}|null{
 const s=input.normalize('NFKC').trim().toUpperCase().replace(/[，；;]/g,',');
 const plain=s.match(/^([+-]?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*([+-]?\d{1,3}(?:\.\d+)?)$/);
 if(plain){const lat=+plain[1],lon=+plain[2];return Math.abs(lat)<=90&&Math.abs(lon)<=180?{lat,lon}:null;}
 const canonical=s.replace(/([NSEW])\s*([+-]?\d{1,3}(?:\.\d+)?)(?=\s|,|$)/g,'$2$1');
 const parts=[...canonical.matchAll(/([NSEW])?\s*([+-]?\d{1,3}(?:\.\d+)?)\s*(?:°\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′]\s*(?:(\d{1,2}(?:\.\d+)?)\s*["″])?)?)?\s*([NSEW])?/g)];
 if(parts.length!==2)return null;
 let lat:number|undefined,lon:number|undefined;
 for(const p of parts){const d=p[1]||p[5];if(!d||(p[1]&&p[5]&&p[1]!==p[5]))return null;const minutes=Number(p[3]||0),seconds=Number(p[4]||0);if(minutes>=60||seconds>=60)return null;const sign=d==='S'||d==='W'?-1:1;const value=(Math.abs(+p[2])+minutes/60+seconds/3600)*sign;if('NS'.includes(d)){if(lat!==undefined)return null;lat=value;}else{if(lon!==undefined)return null;lon=value;}}
 const leftover=canonical.replace(/([NSEW])?\s*([+-]?\d{1,3}(?:\.\d+)?)\s*(?:°\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′]\s*(?:(\d{1,2}(?:\.\d+)?)\s*["″])?)?)?\s*([NSEW])?/g,'').replace(/[\s,]/g,'');
 return !leftover&&lat!==undefined&&lon!==undefined&&Math.abs(lat)<=90&&Math.abs(lon)<=180?{lat,lon}:null;
}
export function photonResults(payload:{features?:{geometry?:{coordinates?:number[]};properties?:Record<string,unknown>}[]}):PlaceResult[]{
 const seen=new Set<string>();return (payload.features||[]).flatMap(f=>{const [lon,lat]=f.geometry?.coordinates||[],p=f.properties||{};if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return [];const id=String(p.osm_type||'')+String(p.osm_id||`${lat}/${lon}`);if(seen.has(id))return [];seen.add(id);const name=String(p.name||p.street||p.city||'地图地点').slice(0,200);const detail=[p.street,p.housenumber,p.district,p.city,p.state,p.country].filter((v,i,a)=>typeof v==='string'&&v!==name&&a.indexOf(v)===i).join(' · ').slice(0,400);return [{id,name,detail,lat,lon,kind:String(p.type||p.osm_value||'place')}];}).slice(0,8);
}
// Large natural features are incompletely indexed by address-oriented geocoders.
const naturalPlaces:[string,string[],number,number][]=[
 ['北冰洋',['北冰洋','arctic ocean','the arctic ocean'],85,0],
 ['南大洋',['南大洋','南冰洋','southern ocean','antarctic ocean'], -65,0],
 ['太平洋',['太平洋','pacific ocean','the pacific ocean'],0,-150],
 ['大西洋',['大西洋','atlantic ocean','the atlantic ocean'],0,-30],
 ['印度洋',['印度洋','indian ocean','the indian ocean'],-20,80],
 ['北极点',['北极','北极点','north pole'],90,0],
 ['南极点',['南极点','south pole'],-90,0],
 ['南极洲',['南极洲','南极','antarctica'],-82,0],
 ['地中海',['地中海','mediterranean sea'],35,18],
 ['南海',['南海','south china sea'],14,114]
];
export function naturalPlace(query:string):PlaceResult|null{const q=normalizeQuery(query),p=naturalPlaces.find(p=>p[1].includes(q));return p?{id:'natural:'+p[1][1],name:p[0],detail:p[1][1]+' · 大型自然地理区域参考位置',lat:p[2],lon:p[3],kind:'ocean'}:null;}
// Query aliases broaden recall, without applying a user's current country as a bias.
const overseasAliases:Record<string,string>={
 '华盛顿':'Washington','華盛頓':'Washington','华盛顿特区':'Washington DC','華盛頓特區':'Washington DC','美国华盛顿':'Washington DC','華盛頓州':'Washington','华盛顿州':'Washington',
 '纽约':'New York','紐約':'New York','洛杉矶':'Los Angeles','洛杉磯':'Los Angeles','旧金山':'San Francisco','舊金山':'San Francisco','伦敦':'London','倫敦':'London','巴黎':'Paris','柏林':'Berlin','东京':'Tokyo','東京':'Tokyo','大阪':'Osaka','悉尼':'Sydney','墨尔本':'Melbourne','墨爾本':'Melbourne','温哥华':'Vancouver','溫哥華':'Vancouver','多伦多':'Toronto','多倫多':'Toronto','新加坡':'Singapore','首尔':'Seoul','首爾':'Seoul','汉堡':'Hamburg','漢堡':'Hamburg','罗马':'Rome','羅馬':'Rome','慕尼黑':'Munich','布拉格':'Prague','维也纳':'Vienna','維也納':'Vienna'};
export function searchQueries(query:string){const q=normalizeQuery(query);return overseasAliases[q]?[overseasAliases[q],q]:[q];}
export function mergeSearchResults(groups:PlaceResult[][]){const seen=new Set<string>();return groups.flat().filter(p=>{if(seen.has(p.id))return false;seen.add(p.id);return true;}).slice(0,12);}
export function clarifyWashington(results:PlaceResult[],query:string){
 if(!/华盛顿|華盛頓|washington/i.test(query))return results;
 const rows=results.map(p=>{if(!/^washington$/i.test(p.name))return p;if(p.kind==='state'&&p.lat>45&&p.lat<50&&p.lon>-125&&p.lon<-116)return {...p,name:'华盛顿州 · Washington State'};if(Math.abs(p.lat-38.8951)<.3&&Math.abs(p.lon+77.0364)<.3)return {...p,name:'华盛顿特区 · Washington, D.C.'};return p;});
 const state=/州|state/i.test(query);const rank=(p:PlaceResult)=>p.name.startsWith(state?'华盛顿州':'华盛顿特区')?0:p.name.startsWith('华盛顿')&&p.lon<0?1:2;
 return rows.sort((a,b)=>rank(a)-rank(b));
}
