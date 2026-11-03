import {build} from 'esbuild';
import {cp,mkdir} from 'node:fs/promises';
await mkdir('public/dist/cesium',{recursive:true});
for(const name of ['Assets','Workers','ThirdParty','Widgets'])await cp('node_modules/cesium/Build/Cesium/'+name,'public/dist/cesium/'+name,{recursive:true});
// LERC also supports Node; its guarded node:module import is never executed in a browser.
await build({entryPoints:['src/client/bootstrap.ts','src/client/index.tsx','src/client/map.tsx','src/client/terrain-worker.ts','src/client/atlas-worker.ts'],bundle:true,outdir:'public/dist',format:'esm',splitting:true,minify:true,target:'es2022',external:['module'],define:{CESIUM_BASE_URL:JSON.stringify('/dist/cesium/')}});

await cp('node_modules/lerc/lerc-wasm.wasm','public/dist/lerc-wasm.wasm');
