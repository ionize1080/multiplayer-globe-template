import {TerrainDiskCache} from './terrain-cache';
import {decodeTerrarium,terrainPosition,TERRAIN_MAX_LEVEL} from '../terrain';
export class TerrainData {
  private disk=new TerrainDiskCache();
  private cache=new Map<string,Float32Array>();
  private pending=new Map<string,Promise<Float32Array>>();
  private queue:(()=>void)[]=[];
  private active=0;
  private abort=new AbortController();
  constructor(private onExpired:()=>void){}
  get busy(){return this.pending.size>=32;}
  dispose(){this.abort.abort();this.cache.clear();}
  async tile(z:number,x:number,y:number):Promise<Float32Array>{
    const n=2**z;x=((x%n)+n)%n;y=Math.max(0,Math.min(n-1,y));const key=`${z}/${x}/${y}`;
    const cached=this.cache.get(key);if(cached){this.cache.delete(key);this.cache.set(key,cached);return cached;}
    const pending=this.pending.get(key);if(pending)return pending;
    const task=(async()=>{
      await new Promise<void>(resolve=>{this.queue.push(resolve);this.pump();});
      try{
        this.abort.signal.throwIfAborted();
        const path=`/api/globe/terrain/${key}.png`;const saved=await this.disk.get(path);
        const response=saved||await fetch(path,{signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(20000)])});
        if(response.status===401){this.onExpired();throw Error('登录已过期');}
        if(!response.ok)throw Error('地形数据暂不可用');
        const blob=await response.blob();
        const bitmap=await createImageBitmap(blob,{colorSpaceConversion:'none'});
        try{
          if(bitmap.width!==256||bitmap.height!==256)throw Error('地形瓦片尺寸无效');
          const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
          const ctx=canvas.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(bitmap,0,0);
          const rgba=ctx.getImageData(0,0,256,256).data,heights=new Float32Array(65536);
          for(let i=0;i<heights.length;i++)heights[i]=decodeTerrarium(rgba[i*4],rgba[i*4+1],rgba[i*4+2],rgba[i*4+3]);
          if(!saved)void this.disk.put(path,blob);
          this.abort.signal.throwIfAborted();this.cache.set(key,heights);
          while(this.cache.size>96)this.cache.delete(this.cache.keys().next().value!);
          return heights;
        }finally{bitmap.close();}
      }finally{this.active--;this.pump();}
    })();
    this.pending.set(key,task);try{return await task;}finally{this.pending.delete(key);}
  }
  private pump(){while(this.active<6&&this.queue.length){this.active++;this.queue.shift()!();}}
  async point(lat:number,lon:number){
    const p=terrainPosition(lat,lon,TERRAIN_MAX_LEVEL);if(!p)throw Error('此纬度超出地形数据覆盖范围');
    // Nearest native sample: no smoothing across shorelines or invented water level.
    const x=Math.floor(p.x),y=Math.floor(p.y),data=await this.tile(TERRAIN_MAX_LEVEL,x,y);
    const value=data[Math.min(255,Math.floor((p.y-y)*256))*256+Math.min(255,Math.floor((p.x-x)*256))];
    if(!Number.isFinite(value))throw Error('此位置暂无有效海拔数据');
    return value;
  }
  async grid(z:number,x:number,y:number){
    const tiles=await Promise.all([this.tile(z,x,y),this.tile(z,x+1,y),this.tile(z,x,y+1),this.tile(z,x+1,y+1)]);
    const grid=new Float32Array(257*257);
    for(let row=0;row<=256;row++)for(let col=0;col<=256;col++)grid[row*257+col]=tiles[(row===256?2:0)+(col===256?1:0)][(row%256)*256+col%256];
    return grid;
  }
}
