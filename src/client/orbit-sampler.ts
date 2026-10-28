import * as satellite from "satellite.js";
import type { OrbitSample } from "./orbit-interpolation";

export function orbitPosition(rec: satellite.SatRec, time: number): number[] | null {
  try {
    const date = new Date(time);
    const pv = satellite.propagate(rec, date);
    if (!pv || !pv.position || typeof pv.position === "boolean") return null;
    const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
    if (![gd.latitude, gd.longitude, gd.height].every(Number.isFinite) || gd.height < 80) return null;
    const radius = 1 + gd.height / 6371;
    const equatorial = radius * Math.cos(gd.latitude);
    return [equatorial * Math.cos(gd.longitude), radius * Math.sin(gd.latitude), -equatorial * Math.sin(gd.longitude)];
  } catch { return null; }
}

export function sampleOrbit(rec: satellite.SatRec, time: number): OrbitSample | null {
  const position = orbitPosition(rec, time);
  // Central difference includes Earth rotation and the globe's geodetic mapping.
  const before = position && orbitPosition(rec, time - 500);
  const after = before && orbitPosition(rec, time + 500);
  if (!position || !before || !after) return null;
  return { time, position, velocity: after.map((v, j) => v - before[j]) };
}
