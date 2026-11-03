const NAME='ionize-terrain-v2',TTL=30*86400*1000,MAX=256;
/** Public DEM pixels only; no sessions, accounts or personal responses enter this cache. */
export class TerrainDiskCache{
 private cache:Promise<Cache|null>;private writes=0;private pruning:Promise<void>|null=null;
 constructor(){this.cache=typeof caches==='undefined'?Promise.resolve(null):caches.open(NAME).catch(()=>null);}
 async get(path:string){try{const c=await this.cache,r=await c?.match(path);if(!r)return null;const time=Number(r.headers.get('X-Terrain-Cached-At'));if(!time||Date.now()-time>TTL){await c?.delete(path);return null;}return r;}catch{return null;}}
 async put(path:string,blob:Blob){try{const c=await this.cache;if(!c)return;await c.put(path,new Response(blob,{headers:{'Content-Type':'image/png','X-Terrain-Cached-At':String(Date.now())}}));if(++this.writes%16===1&&!this.pruning){this.pruning=(async()=>{const keys=await c.keys();for(const key of keys.slice(0,Math.max(0,keys.length-MAX)))await c.delete(key);})().finally(()=>{this.pruning=null;});await this.pruning;}}catch{/* Storage quota and private browsing never block rendering. */}}
}
