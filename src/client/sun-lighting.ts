import { MathUtils, Vector3 } from "three";

export type SunLighting = { mode: "photo"; azimuth: number } | { mode: "live" };

/** Camera-relative light: 0 faces the viewer; positive angles move screen-right.
 * The globe camera orbits horizontally around the origin. No view mutation.
 */
export function photoSunDirection(azimuth: number, cameraYaw: number, out: Vector3): Vector3 {
  const degrees = Number.isFinite(azimuth) ? MathUtils.clamp(azimuth, -180, 180) : 0;
  const angle = cameraYaw + MathUtils.degToRad(degrees);
  return out.set(Math.sin(angle), 0, Math.cos(angle));
}
