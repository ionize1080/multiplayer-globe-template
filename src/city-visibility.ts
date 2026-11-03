import type {Bounds} from './weather-tiles';
export type CityPlace={name:string;lat:number;lon:number;rank:number;kind?:string};
export function cityReferenceKeys(bounds:Bounds){
 const east=bounds.east<bounds.west?bounds.east+360:bounds.east;
 if(east-bounds.west>90||bounds.north-bounds.south>65)return [];
 const keys=new Set<string>();
 for(let y=Math.max(0,Math.floor((bounds.south+90)/20));y<=Math.min(8,Math.floor((bounds.north+90)/20));y++)for(let x=Math.floor((bounds.west+180)/20);x<=Math.floor((east+180)/20);x++)keys.add(`${((x%18)+18)%18}-${y}`);
 return [...keys];
}
export function mergeCityPlaces(major:CityPlace[],regional:CityPlace[]){const seen=new Set<string>();return [...major,...regional].filter(p=>{if(p.kind&&p.kind!=='city')return false;const key=`${p.name}/${p.lat.toFixed(1)}/${p.lon.toFixed(1)}`;if(seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>a.rank-b.rank);}
