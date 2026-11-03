// Shared WGS84 tile geometry. Integer tile IDs make nearby users reuse the cache.
export const WEATHER_STEPS = [5, 2.5, 1, .5, .25, .1, .05, .025] as const;
export type Bounds = {west:number;south:number;east:number;north:number};
export type WeatherPoint = {humidity?:number|null;pressure?:number|null;cloud?:number|null;lat:number;lon:number;time:string|null;temperature:number|null;wind:number|null;direction:number|null};
export type WeatherGrid = {points:WeatherPoint[];resolution:number;fetchedAt:string};
export type WeatherTile = WeatherGrid & Bounds & {level:number;x:number;y:number;stale?:boolean};
export const wrapLongitude=(lon:number)=>((lon+180)%360+360)%360-180;
export function tileGeometry(level:number,x:number,y:number) {
  if(!Number.isInteger(level)||level<0||level>=WEATHER_STEPS.length)return null;
  const resolution=WEATHER_STEPS[level],size=resolution*4,nx=Math.round(360/size),ny=Math.round(180/size);
  if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||x>=nx||y<0||y>=ny)return null;
  const west=Number((-180+x*size).toFixed(6)),south=Number((-90+y*size).toFixed(6));
  return {level,x,y,resolution,west,south,east:Number((west+size).toFixed(6)),north:Number((south+size).toFixed(6)),key:`${level}/${x}/${y}`};
}
export function planWeatherTiles(bounds:Bounds) {
  const east=bounds.east<=bounds.west?bounds.east+360:bounds.east;
  if(![bounds.west,east,bounds.south,bounds.north].every(Number.isFinite)||bounds.north<=bounds.south)return [];
  for(let level=WEATHER_STEPS.length-1;level>=0;level--){
    const size=WEATHER_STEPS[level]*4,nx=Math.round(360/size),ny=Math.round(180/size);
    const left=Math.floor((bounds.west+180)/size),right=Math.ceil((east+180)/size-1e-9)-1;
    const bottom=Math.max(0,Math.floor((bounds.south+90)/size)),top=Math.min(ny-1,Math.ceil((bounds.north+90)/size-1e-9)-1);
    if((right-left+1)*(top-bottom+1)>6)continue;
    const result=[];
    for(let y=bottom;y<=top;y++)for(let x=left;x<=right;x++){const tile=tileGeometry(level,((x%nx)+nx)%nx,y);if(tile)result.push(tile);}
    return result;
  }
  return [];
}
// Interpolate wind components, not angles (359° and 1° both point north).
export function interpolate(points:WeatherPoint[],indices:number[],fx:number,fy:number) {
  const weights=[(1-fx)*(1-fy),fx*(1-fy),(1-fx)*fy,fx*fy];
  let temperature=0,u=0,v=0,tempValid=true,windValid=true;
  for(let i=0;i<4;i++){
    if(weights[i]<1e-10)continue;const p=points[indices[i]];
    if(!p||p.temperature===null)tempValid=false;else temperature+=p.temperature*weights[i];
    if(!p||p.wind===null||p.direction===null)windValid=false;
    else{const angle=p.direction*Math.PI/180;u-=p.wind*Math.sin(angle)*weights[i];v-=p.wind*Math.cos(angle)*weights[i];}
  }
  return {temperature:tempValid?temperature:null,wind:windValid?Math.hypot(u,v):null,u:windValid?u:null,v:windValid?v:null};
}
