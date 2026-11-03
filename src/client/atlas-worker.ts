import {AtlasRaster,type RasterTask} from './atlas-raster';
const scope=self as unknown as {onmessage:(e:MessageEvent<RasterTask>)=>void;postMessage:(m:unknown,transfer?:Transferable[])=>void};
const raster=new AtlasRaster(),queue:RasterTask[]=[];let active=false;
async function run(){if(active)return;active=true;while(queue.length){const task=queue.shift()!;try{if(task.lat!==undefined&&task.lon!==undefined){const value=await raster.point(task.kind,task.lat,task.lon);scope.postMessage({id:task.id,value});}else{const rgba=await raster.tile(task.kind,task.z!,task.x!,task.y!),canvas=new OffscreenCanvas(256,256);canvas.getContext('2d')!.putImageData(new ImageData(rgba,256,256),0,0);const bitmap=canvas.transferToImageBitmap();scope.postMessage({id:task.id,bitmap},[bitmap]);}}catch(e){scope.postMessage({id:task.id,error:e instanceof Error?e.message:'图谱数据暂不可用'});}}active=false;}
scope.onmessage=e=>{if(e.data.lat!==undefined)queue.unshift(e.data);else queue.push(e.data);void run();};
