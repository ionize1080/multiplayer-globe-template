export type SatelliteBounds={west:number;east:number;south:number;north:number};
export type SatelliteMode='latest'|'clear';
export type SatelliteScene={id:string;acquiredAt:string;cloudCover:number|null};
export type SatelliteManifest=SatelliteScene&{bounds:SatelliteBounds;width:number;height:number;resolutionMeters:number;key:string;imageUrl:string;mode:SatelliteMode;checkedAt:string};
/** Quantized view keys, bounded area, aspect-preserving output, never oversample 10 m data. */
export function satelliteView(bounds:SatelliteBounds){
 const {west,east,south,north}=bounds;
 if(![west,east,south,north].every(Number.isFinite)||west< -180||east>180||south< -85||north>85||east<=west||north<=south)return null;
 const b={west:Math.floor(west*1000)/1000,east:Math.ceil(east*1000)/1000,south:Math.floor(south*1000)/1000,north:Math.ceil(north*1000)/1000};
 const metersX=(b.east-b.west)*111320*Math.cos((b.north+b.south)*Math.PI/360),metersY=(b.north-b.south)*111320;
 if(metersX>160000||metersY>160000||b.east-b.west>8)return null;
 const resolution=Math.max(10,metersX/1024,metersY/1024);
 const width=Math.max(1,Math.ceil(metersX/resolution)),height=Math.max(1,Math.ceil(metersY/resolution));
 return {bounds:b,width:Math.min(1024,width),height:Math.min(1024,height),resolutionMeters:Math.round(resolution),key:[b.west,b.south,b.east,b.north].join(',')};
}
export function selectSatelliteScene(payload:unknown,mode:SatelliteMode,now=Date.now()):SatelliteScene|null{
 const features=(payload as {features?:unknown[]})?.features;if(!Array.isArray(features))return null;
 const rows:SatelliteScene[]=[];
 for(const raw of features){const f=raw as {id?:unknown;properties?:Record<string,unknown>};if(typeof f?.id!=='string'||f.id.length>250)continue;const date=f.properties?.datetime,time=typeof date==='string'?Date.parse(date):NaN;if(!Number.isFinite(time)||time>now+60000||time<now-30*86400000)continue;const cloud=f.properties?.['eo:cloud_cover'];rows.push({id:f.id,acquiredAt:new Date(time).toISOString(),cloudCover:typeof cloud==='number'&&cloud>=0&&cloud<=100?cloud:null});}
 rows.sort((a,b)=>(mode==='clear'?(a.cloudCover??101)-(b.cloudCover??101):0)||Date.parse(b.acquiredAt)-Date.parse(a.acquiredAt));return rows[0]||null;
}
export function satelliteProcess(manifest:SatelliteManifest){
 const {bounds:b,width,height,acquiredAt}=manifest,time=Date.parse(acquiredAt);
 return {input:{bounds:{bbox:[b.west,b.south,b.east,b.north],properties:{crs:'http://www.opengis.net/def/crs/EPSG/0/4326'}},data:[{type:'sentinel-2-l2a',dataFilter:{timeRange:{from:new Date(time-500).toISOString(),to:new Date(time+500).toISOString()},mosaickingOrder:'mostRecent'},processing:{upsampling:'BILINEAR',downsampling:'BILINEAR'}}]},output:{width,height,responses:[{identifier:'default',format:{type:'image/png'}}]},evalscript:'//VERSION=3\nfunction setup(){return {input:["B04","B03","B02","dataMask"],output:{bands:4,sampleType:"AUTO"}};}\nfunction evaluatePixel(s){return [2.5*s.B04,2.5*s.B03,2.5*s.B02,s.dataMask];}'};
}
