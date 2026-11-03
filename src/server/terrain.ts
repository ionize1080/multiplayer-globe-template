import {terrainTileId} from '../terrain';
export async function terrainTile(request:Request):Promise<Response>{
  const id=terrainTileId(new URL(request.url).pathname);
  if(!id)return Response.json({error:'地形瓦片坐标无效'},{status:400,headers:{'Cache-Control':'no-store'}});
  // Fixed public upstream; never forward login cookies or accept an arbitrary URL.
  const upstream=await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${id.z}/${id.x}/${id.y}.png`,{
    signal:AbortSignal.timeout(15000),cf:{cacheEverything:true,cacheTtlByStatus:{'200-299':2592000,'404':60,'500-599':0}}
  });
  if(!upstream.ok||!upstream.headers.get('Content-Type')?.includes('image/png')){
    await upstream.body?.cancel();
    return Response.json({error:'地形数据暂不可用'},{status:502,headers:{'Cache-Control':'no-store'}});
  }
  // Authentication happens before this route. Shared upstream caching is independent
  // of the private browser response and never stores a user's authenticated response.
  return new Response(upstream.body,{headers:{'Content-Type':'image/png','Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff'}});
}
