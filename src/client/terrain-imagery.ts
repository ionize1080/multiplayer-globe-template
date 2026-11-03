import type * as Cesium from 'cesium';
import type {terrainViewPlan} from '../terrain';
/** Keep regional coverage just inside tile edges (at most 6.4 cm on the ground).
 * At exact Mercator boundaries, inverse projection rounding can select the adjacent
 * tile with no overlap. Cesium 1.147 then projects an undefined clipped rectangle
 * and stops rendering. Retain the same minimum LOD and at-most-four starting tiles.
 */
export function terrainImageryRectangle(C:typeof Cesium,plan:ReturnType<typeof terrainViewPlan>){
 const rectangle=C.Rectangle.fromDegrees(plan.west,plan.south,plan.east,plan.north);
 if(plan.key!=='world'){
  const inset=Math.min(1e-8,rectangle.width/4,rectangle.height/4);
  rectangle.west+=inset;rectangle.east-=inset;rectangle.south+=inset;rectangle.north-=inset;
 }
 return rectangle;
}
