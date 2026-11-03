import * as satellite from "satellite.js";
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

export function sunDirModel(date: Date, out = new Vector3()) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = ((((280.460 + 0.9856474 * n) % 360) + 360) % 360) * (Math.PI / 180);
  const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * (Math.PI / 180);
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * (Math.PI / 180);
  const epsilon = (23.439 - 0.0000004 * n) * (Math.PI / 180);
  const cosEps = Math.cos(epsilon);
  const sinEps = Math.sin(epsilon);
  const cosL = Math.cos(lambda);
  const sinL = Math.sin(lambda);
  const alpha = Math.atan2(cosEps * sinL, cosL);
  const delta = Math.asin(sinEps * sinL);
  const gmst = satellite.gstime(date);
  const cosd = Math.cos(delta);
  const x = cosd * Math.cos(alpha - gmst);
  const y = cosd * Math.sin(alpha - gmst);
  const z = Math.sin(delta);
  return out.set(x, z, -y).normalize();
}
