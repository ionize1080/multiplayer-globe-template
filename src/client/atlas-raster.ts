import {fromUrl,type GeoTIFF,type RemoteSourceOptions,type BlockedSourceOptions} from 'geotiff';
import * as Lerc from 'lerc';
import {climateClasses,landformClasses,climateResolution,geographicTile} from '../atlas';
export type RasterKind='climate'|'landform';
export type RasterTask={id:number;kind:RasterKind;z?:number;x?:number;y?:number;lat?:number;lon?:number};
const classes={climate:climateClasses,landform:landformClasses};
export function colorize(values:ArrayLike<number>,kind:RasterKind){const rgba=new Uint8ClampedArray(values.length*4),palette=new Map(classes[kind].map(c=>[c.id,[1,3,5].map(k=>parseInt(c.color.slice(k,k+2),16))]));for(let i=0;i<values.length;i++){const c=palette.get(values[i]);if(c){rgba.set(c,i*4);rgba[i*4+3]=255;}}return rgba;}
export function climatePixel(lat:number,lon:number,level:number){const r=climateResolution(level),col=Math.floor((Math.min(lon,179.998559999)+180)/r),row=Math.floor((90-Math.max(-89.999279999,lat))/r);return {x:Math.floor(col/256),y:Math.floor(row/256),index:(row%256)*256+col%256};}
export class AtlasRaster {
 private lercReady:Promise<void>|undefined;
 private tiles=new Map<string,Promise<Lerc.LercData>>();
 private tiff:Promise<GeoTIFF>|undefined;
 constructor(private root=''){}
 private climate(z:number,x:number,y:number){const key=`${z}/${x}/${y}`;let p=this.tiles.get(key);if(!p){p=(async()=>{this.lercReady??=Lerc.load({locateFile:()=>this.root+'/dist/lerc-wasm.wasm'});await this.lercReady;const r=await fetch(this.root+'/api/globe/atlas/climate/'+key);if(!r.ok)throw Error(r.status===401?'SESSION_EXPIRED':'气候数据加载失败');const d=Lerc.decode(await r.arrayBuffer());if(d.width!==256||d.height!==256||d.pixels.length!==1)throw Error('无效的气候数据');return d;})();this.tiles.set(key,p);p.catch(()=>this.tiles.delete(key));while(this.tiles.size>96)this.tiles.delete(this.tiles.keys().next().value!);}return p;}
 private land(){if(!this.tiff){const options:RemoteSourceOptions&BlockedSourceOptions={allowFullFile:false,blockSize:65536,cacheSize:128,maxRanges:0};this.tiff=fromUrl(this.root+'/api/globe/atlas/landform/data',options);this.tiff.catch(()=>{this.tiff=undefined;});}return this.tiff;}
 async point(kind:RasterKind,lat:number,lon:number){
  if(kind==='climate'){const p=climatePixel(lat,lon,7),d=await this.climate(7,p.x,p.y);return d.mask&&!d.mask[p.index]?0:Number(d.pixels[0][p.index]);}
  const tiff=await this.land(),im=await tiff.getImage(),[w,s,e,n]=im.getBoundingBox();if(lon<w||lon>=e||lat<=s||lat>n)return 0;const x=Math.floor((lon-w)/(e-w)*im.getWidth()),y=Math.floor((n-lat)/(n-s)*im.getHeight());const v=await im.readRasters({window:[x,y,x+1,y+1],samples:[0],interleave:true});return Number(v[0]);
 }
 async tile(kind:RasterKind,z:number,x:number,y:number){
  const b=geographicTile(z,x,y);if(!b)throw Error('Invalid raster tile');let values:ArrayLike<number>;
  if(kind==='climate'){
   const level=Math.min(7,Math.max(0,Math.ceil(Math.log2(climateResolution(0)/((b.east-b.west)/256))))),r=climateResolution(level);
   const first=climatePixel(b.north-(b.north-b.south)/512,b.west+(b.east-b.west)/512,level),last=climatePixel(b.south+(b.north-b.south)/512,b.east-(b.east-b.west)/512,level),tiles=new Map<string,Lerc.LercData>();const loads:Promise<void>[]=[];
   for(let row=first.y;row<=last.y;row++)for(let col=first.x;col<=last.x;col++)loads.push(this.climate(level,col,row).then(d=>{tiles.set(col+','+row,d);}));await Promise.all(loads);
   const out=new Uint8Array(65536);for(let j=0;j<256;j++)for(let i=0;i<256;i++){const lat=b.north-(j+.5)*(b.north-b.south)/256,lon=b.west+(i+.5)*(b.east-b.west)/256;if(lon>=179.99856||lat<=-89.99928)continue;const col=Math.floor((lon+180)/r),row=Math.floor((90-lat)/r),d=tiles.get(Math.floor(col/256)+','+Math.floor(row/256)),index=(row%256)*256+col%256;if(d&&(!d.mask||d.mask[index]))out[j*256+i]=d.pixels[0][index];}values=out;
  }else{
   const tiff=await this.land(),data=await tiff.readRasters({bbox:[b.west,b.south,b.east,b.north],width:256,height:256,samples:[0],interleave:true,resampleMethod:'nearest',fillValue:255});if(!ArrayBuffer.isView(data))throw Error('Invalid landform raster');values=data;
  }
  return colorize(values,kind);
 }
}
