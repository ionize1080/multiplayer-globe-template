// Mapzen Terrarium: WGS84 Web Mercator XY, encoded height in metres.
export const TERRAIN_MAX_LEVEL=14, MERCATOR_LIMIT=85.0511287798066;
export function terrainTileId(path:string){
  const match=/^\/api\/globe\/terrain\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.png$/.exec(path);
  if(!match)return null;
  const [z,x,y]=match.slice(1).map(Number),n=2**z;
  return z<=TERRAIN_MAX_LEVEL&&x<n&&y<n?{z,x,y}:null;
}
export function terrainPosition(lat:number,lon:number,z:number){
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>MERCATOR_LIMIT)return null;
  const n=2**z,longitude=((lon+180)%360+360)%360-180;
  return {x:(longitude+180)/360*n,y:Math.min(n-Number.EPSILON*n,Math.max(0,(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n))};
}
export function decodeTerrarium(r:number,g:number,b:number,alpha=255){
  const h=r*256+g+b/256-32768;
  return alpha===0||h<=-32768?NaN:h;
}
export function contourInterval(z:number){return z>=13?20:z>=11?50:z>=9?100:z>=7?250:z>=5?500:1000;}
// Corners are NW, NE, SE, SW. Split saddle cells using their centre value.
export function contourSegments(values:number[],level:number):number[][]{
  if(values.some(v=>!Number.isFinite(v)))return [];
  const corners=[[0,0],[1,0],[1,1],[0,1]],crossings:{edge:number,p:number[]}[]=[];
  for(let i=0;i<4;i++){const j=(i+1)%4,a=values[i],b=values[j];if((a>=level)===(b>=level))continue;const t=(level-a)/(b-a);crossings.push({edge:i,p:[corners[i][0]+t*(corners[j][0]-corners[i][0]),corners[i][1]+t*(corners[j][1]-corners[i][1])]});}
  if(crossings.length===2)return [[...crossings[0].p,...crossings[1].p]];
  if(crossings.length===4){const centre=values.reduce((a,b)=>a+b)/4;return ((values[0]>=level)===(centre>=level)?[[0,1],[2,3]]:[[0,3],[1,2]]).map(([a,b])=>[...crossings[a].p,...crossings[b].p]);}
  return [];
}
export function terrainColor(h:number):number[]{
  const stops=[[ -11000,16,37,62],[-1,42,106,138],[0,71,133,100],[500,144,163,109],[1500,190,170,122],[3000,160,124,100],[5000,183,175,168],[8000,245,247,250]];
  for(let i=1;i<stops.length;i++){const a=stops[i-1],b=stops[i];if(h<=b[0]){const t=Math.max(0,(h-a[0])/(b[0]-a[0]));return [1,2,3].map(k=>a[k]+(b[k]-a[k])*t);}}
  return stops.at(-1)!.slice(1);
}
