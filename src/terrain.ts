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
// Start at the visible region's LOD instead of downloading every global ancestor.
export function terrainViewPlan(bounds:{west:number;east:number;south:number;north:number}){
 const {west,east,south,north}=bounds;
 const global={key:'world',minimumLevel:0,west:-180,east:180,south:-MERCATOR_LIMIT,north:MERCATOR_LIMIT};
 if(![west,east,south,north].every(Number.isFinite)||east<=west||north<=south||south>=MERCATOR_LIMIT||north<=-MERCATOR_LIMIT||east-west>100||north-south>80)return global;
 const dx=(east-west)*.15,dy=(north-south)*.15;
 const a={lon:Math.max(-180,west-dx),lat:Math.min(MERCATOR_LIMIT,north+dy)},b={lon:Math.min(180-1e-9,east+dx),lat:Math.max(-MERCATOR_LIMIT,south-dy)};
 for(let z=12;z>=0;z--){const nw=terrainPosition(a.lat,a.lon,z)!,se=terrainPosition(b.lat,b.lon,z)!;const left=Math.floor(nw.x),right=Math.floor(se.x),top=Math.floor(nw.y),bottom=Math.floor(se.y);if((right-left+1)*(bottom-top+1)>4)continue;const n=2**z,latitude=(y:number)=>Math.atan(Math.sinh(Math.PI*(1-2*y/n)))*180/Math.PI;return {key:`${z}/${left}/${top}/${right}/${bottom}`,minimumLevel:z,west:left/n*360-180,east:(right+1)/n*360-180,north:latitude(top),south:latitude(bottom+1)};}
 return global;
}
