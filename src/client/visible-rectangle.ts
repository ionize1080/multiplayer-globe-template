import type {Viewer} from 'cesium';
/** Cesium's spherical horizon calculation can miss the flat 2D map. */
export function visibleRectangle(viewer:Viewer,C:typeof import('cesium')){
 if(viewer.scene.mode===C.SceneMode.SCENE2D){
  if(viewer.camera.positionCartographic.height>3000000)return C.Rectangle.clone(C.Rectangle.MAX_VALUE);
  const {clientWidth:w,clientHeight:h}=viewer.scene.canvas,ellipsoid=viewer.scene.globe.ellipsoid;
  const corners=[[1,1],[w-1,1],[w-1,h-1],[1,h-1]].map(([x,y])=>viewer.camera.pickEllipsoid(new C.Cartesian2(x,y),ellipsoid));
  if(corners.every(p=>p!==undefined))return C.Rectangle.fromCartographicArray(corners.map(p=>ellipsoid.cartesianToCartographic(p!)));
  return C.Rectangle.clone(C.Rectangle.MAX_VALUE);
 }
 return viewer.camera.computeViewRectangle();
}
