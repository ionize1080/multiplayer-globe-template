import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as satellite from "satellite.js";
import { OrbitInterpolator, hermitePosition, type OrbitSample } from "../src/client/orbit-interpolation";
import { sampleOrbit, orbitPosition } from "../src/client/orbit-sampler";

const epoch = Date.parse("2026-10-28T12:00:00Z");
function linear(index: number, time: number): OrbitSample {
  return { time, position: [(time - epoch) / 1000, index, 1], velocity: [1, 0, 0] };
}

test("chunked preparation displays the current instant and moves on every frame across keyframes", () => {
  const motion = new OrbitInterpolator(6, linear);
  const out = new Float32Array(18);
  motion.update(epoch, 2);
  assert.equal(motion.render(epoch, out), 2);
  motion.update(epoch + 16, 2);
  motion.update(epoch + 32, 2);
  assert.equal(motion.render(epoch + 32, out), 6);
  for (let dt = 50; dt < 60_000; dt += 50) {
    motion.update(epoch + dt, 2);
    assert.equal(motion.render(epoch + dt, out), 6);
    for (let i = 0; i < 6; i++) assert.ok(Math.abs(out[i * 3] - dt / 1000) < 0.00001);
  }
});

test("tab suspension and backwards clock changes discard obsolete windows, never extrapolate", () => {
  const motion = new OrbitInterpolator(3, linear);
  const out = new Float32Array(9);
  motion.update(epoch);
  assert.equal(motion.render(epoch + 3_600_000, out), 0);
  motion.update(epoch + 3_600_000);
  assert.equal(motion.render(epoch + 3_600_000, out), 3);
  assert.equal(out[0], 3600);
  motion.update(epoch - 60_000);
  assert.equal(motion.render(epoch - 60_000, out), 3);
  assert.equal(out[0], -60);
});

test("failed orbit records are omitted rather than rendered at a fallback location", () => {
  const motion = new OrbitInterpolator(3, (i, t) => i === 1 ? null : linear(i, t));
  const out = new Float32Array(9);
  motion.update(epoch);
  assert.equal(motion.render(epoch, out), 2);
  assert.equal(out[1], 0);
  assert.equal(out[4], 2);
});

test("15-second cubic interpolation agrees with direct SGP4 within one metre, including the date line", () => {
  const lines = readFileSync("public/starlink-sample.tle", "utf8").trim().split(/\r?\n/);
  const out = new Float32Array(3);
  let maxErrorMetres = 0;
  // Actual catalog records across orbital planes; sample a complete orbital period.
  for (let i = 0; i < 20; i++) {
    const line = i * 30;
    const rec = satellite.twoline2satrec(lines[line + 1], lines[line + 2]);
    for (let dt = 0; dt < 5_400_000; dt += 120_000) {
      const t = epoch + dt;
      const a = sampleOrbit(rec, t)!;
      const b = sampleOrbit(rec, t + 15_000)!;
      assert.ok(a && b);
      for (const fraction of [0.1, 0.5, 0.9]) {
        const sampleTime = t + fraction * 15_000;
        hermitePosition(a, b, sampleTime, out);
        const exact = orbitPosition(rec, sampleTime)!;
        const error = Math.hypot(...exact.map((v, j) => v - out[j])) * 6_371_000;
        maxErrorMetres = Math.max(maxErrorMetres, error);
        assert.ok(error < 1, `interpolation error ${error} m`);
      }
    }
  }
  console.log(`Maximum interpolation-only error: ${maxErrorMetres.toFixed(3)} m (not TLE accuracy)`);
});
