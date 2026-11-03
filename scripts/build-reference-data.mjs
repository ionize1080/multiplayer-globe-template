// Reproducible, public-domain reference assets. No runtime third-party tile API.
import {mkdir,writeFile} from 'node:fs/promises';
const base='https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/';
const files=['ne_10m_admin_0_boundary_lines_land.geojson','ne_10m_admin_1_states_provinces_lines.geojson','ne_10m_populated_places.geojson','ne_10m_admin_1_label_points.geojson'];
const data=await Promise.all(files.map(async name=>{const r=await fetch(base+name);if(!r.ok)throw Error(`${name}: ${r.status}`);return r.json();}));
const tiles=new Map();
function tile(x,y){const key=`${((x%18)+18)%18}-${y}`;if(!tiles.has(key))tiles.set(key,{type:'FeatureCollection',features:[],places:[]});return tiles.get(key);}
// Clip each line segment to 20-degree geographic cells, including the date line.
function clip(a,b,w,s,e,n){let lo=0,hi=1;const dx=b[0]-a[0],dy=b[1]-a[1];for(const [p,q] of [[-dx,a[0]-w],[dx,e-a[0]],[-dy,a[1]-s],[dy,n-a[1]]]){if(p===0){if(q<0)return null;continue;}const t=q/p;if(p<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);if(lo>hi)return null;}if(hi-lo<1e-10)return null;return [[a[0]+lo*dx,a[1]+lo*dy],[a[0]+hi*dx,a[1]+hi*dy]];}
const segments=new Map();
for(let dataset=0;dataset<2;dataset++)for(const f of data[dataset].features){
  if(!f.geometry||!['LineString','MultiLineString'].includes(f.geometry.type))continue;
  const lines=f.geometry.type==='LineString'?[f.geometry.coordinates]:f.geometry.coordinates;
  for(const line of lines)for(let i=1;i<line.length;i++){
    const a=line[i-1],b=[...line[i]];if(b[0]-a[0]>180)b[0]-=360;if(b[0]-a[0]<-180)b[0]+=360;
    for(let y=Math.max(0,Math.floor((Math.min(a[1],b[1])+90)/20));y<=Math.min(8,Math.floor((Math.max(a[1],b[1])+90)/20));y++)for(let x=Math.floor((Math.min(a[0],b[0])+180)/20);x<=Math.floor((Math.max(a[0],b[0])+180)/20);x++){
      const clipped=clip(a,b,-180+x*20,-90+y*20,-160+x*20,-70+y*20);if(!clipped)continue;
      const key=`${((x%18)+18)%18}-${y}`,group=key+':'+dataset;
      if(!segments.has(group))segments.set(group,[]);
      const shift=x<0?360:x>=18?-360:0;
      const pair=clipped.map(p=>[Number((p[0]+shift).toFixed(5)),Number(p[1].toFixed(5))]);
      const parts=segments.get(group),last=parts.at(-1);
      if(last&&last.at(-1)[0]===pair[0][0]&&last.at(-1)[1]===pair[0][1])last.push(pair[1]);else parts.push(pair);
      tile(x,y);
    }
  }
}
for(const [group,coordinates] of segments){const [key,dataset]=group.split(':');tiles.get(key).features.push({type:'Feature',properties:{kind:dataset==='0'?'country':'province'},geometry:{type:'MultiLineString',coordinates}});}
const overview=[];
for(let dataset=2;dataset<4;dataset++)for(const f of data[dataset].features){
  if(f.geometry?.type!=='Point')continue;
  const p=f.properties,[lon,lat]=f.geometry.coordinates;
  const name=p.NAME_ZH||p.name_zh||p.NAME||p.name;if(!name)continue;
  const rank=Number(p.SCALERANK??p.scalerank??6);
  const place={lon,lat,name,rank,kind:dataset===2?'city':'province'};
  if(dataset===2&&rank<=1)overview.push(place);
  tile(Math.min(17,Math.floor((lon+180)/20)),Math.min(8,Math.floor((lat+90)/20))).places.push(place);
}
await mkdir('public/data/reference',{recursive:true});
for(const [key,value] of tiles)await writeFile(`public/data/reference/${key}.json`,JSON.stringify(value));
await writeFile('public/data/reference/index.json',JSON.stringify({version:'ne-5.1.2',size:20,tiles:[...tiles.keys()].sort()}));
await writeFile('public/data/places.json',JSON.stringify(overview));
console.log(`Prepared ${tiles.size} geographic chunks and ${overview.length} overview city labels.`);
