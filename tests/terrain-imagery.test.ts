import {test} from 'node:test';import assert from 'node:assert/strict';import * as C from 'cesium';
import {terrainViewPlan} from '../src/terrain';import {terrainImageryRectangle} from '../src/client/terrain-imagery';
const terrain=new C.EllipsoidTerrainProvider(),geo=terrain.tilingScheme;
// Exercise Cesium's actual tile-to-imagery clipping, which does not require WebGL.
function clip(layer:C.ImageryLayer,level:number,x:number,y:number){
 const tile={rectangle:geo.tileXYToRectangle(x,y,level),level,data:{imagery:[] as {freeResources:()=>void}[]}};
 try{return (layer as unknown as {_createTileImagerySkeletons:(tile:unknown,terrain:C.EllipsoidTerrainProvider)=>boolean})._createTileImagerySkeletons(tile,terrain);}finally{for(const image of tile.data.imagery)image.freeResources();}
}
function imagery(rectangle:C.Rectangle,minimumLevel:number){return new C.ImageryLayer(new C.UrlTemplateImageryProvider({url:'https://example.invalid/{z}/{x}/{y}.png',rectangle,minimumLevel,maximumLevel:14}));}
test('known Singapore edge reproduces the stopped-rendering error, corrected coverage renders with the same LOD',()=>{
 const plan=terrainViewPlan({west:103.805,east:103.835,south:1.34,north:1.36});assert.equal(plan.minimumLevel,12);
 const raw=C.Rectangle.fromDegrees(plan.west,plan.south,plan.east,plan.north),unsafe=imagery(raw,plan.minimumLevel),safe=imagery(terrainImageryRectangle(C,plan),plan.minimumLevel);
 try{assert.throws(()=>clip(unsafe,10,1615,504),/Expected rectangle to be typeof object/);assert.equal(clip(safe,10,1615,504),false,'touching-only neighbour must be excluded');assert.equal(clip(safe,10,1614,504),true,'the covered tile still renders');assert.equal(safe.imageryProvider.minimumLevel,unsafe.imageryProvider.minimumLevel);}finally{unsafe.destroy();safe.destroy();}
});
test('regional terrain edges stay valid across 59,000 tile intersections, zoom levels and global regions',()=>{
 let count=0,covered=0;
 for(const [lon,lat] of [[103.82,1.35],[139.75,35.68],[-77.04,38.9],[2.35,48.86],[15.6,78.2],[179,0],[-150,-70],[0,0]])for(const span of [40,10,2,.3,.03,.003]){
  const plan=terrainViewPlan({west:lon-span/2,east:lon+span/2,south:lat-span/3,north:lat+span/3}),rectangle=terrainImageryRectangle(C,plan),layer=imagery(rectangle,plan.minimumLevel);
  assert.ok(rectangle.width>0&&rectangle.height>0);
  if(plan.key!=='world')assert.ok(Math.abs(rectangle.west-C.Math.toRadians(plan.west))*6378137<.065,'edge adjustment stays below 6.5 cm');
  try{for(let level=0;level<=16;level++)for(const xlon of [plan.west,(plan.west+plan.east)/2,plan.east])for(const ylat of [plan.north,(plan.north+plan.south)/2,plan.south]){
   const xy=geo.positionToTileXY(C.Cartographic.fromDegrees(xlon,ylat),level)!;
   for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
    const x=xy.x+dx,y=xy.y+dy;if(x<0||y<0||x>=geo.getNumberOfXTilesAtLevel(level)||y>=geo.getNumberOfYTilesAtLevel(level))continue;
    if(clip(layer,level,x,y))covered++;count++;
   }
  }}finally{layer.destroy();}
 }
 assert.equal(count,58998);assert.ok(covered>10000,'valid intersecting tiles still produce imagery');
 const world=terrainViewPlan({west:-180,east:180,south:-90,north:90});assert.deepEqual(terrainImageryRectangle(C,world),C.Rectangle.fromDegrees(world.west,world.south,world.east,world.north));
});
