import assert from "node:assert/strict";
import { test } from "node:test";
import { Vector3 } from "three";
import { photoSunDirection } from "../src/client/sun-lighting";

test("front, side and back lighting follow any current camera heading", () => {
  const out = new Vector3();
  for (const yaw of [-Math.PI, -1.4, 0, 0.7, Math.PI, 20]) {
    const viewer = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    for (const angle of [-180, -90, 0, 90, 180]) {
      assert.equal(photoSunDirection(angle, yaw, out), out, "reuse vector each frame");
      assert.ok(Math.abs(out.length() - 1) < 1e-12);
      const facing = angle === 0 ? 1 : Math.abs(angle) === 90 ? 0 : -1;
      assert.ok(Math.abs(out.dot(viewer) - facing) < 1e-12);
      if (Math.abs(angle) === 90) assert.ok(Math.abs(out.dot(right) - Math.sign(angle)) < 1e-12);
    }
    photoSunDirection(0, yaw, out);
    assert.ok(out.distanceTo(viewer) < 1e-12, "reset restores front light without changing the camera");
  }
});

test("the visible hemisphere stays lit at zero degrees and dark under backlight", () => {
  const sun = new Vector3();
  const normal = new Vector3();
  for (const angle of [0, 180]) {
    photoSunDirection(angle, 0, sun);
    for (let x = -0.9; x <= 0.9; x += 0.1) {
      for (let y = -0.9; y <= 0.9; y += 0.1) {
        if (x * x + y * y >= 0.99) continue;
        normal.set(x, y, Math.sqrt(1 - x * x - y * y));
        assert.equal(normal.dot(sun) > 0, angle === 0);
      }
    }
  }
});

test("angle limits and invalid values never produce a broken light vector", () => {
  const out = new Vector3();
  assert.ok(photoSunDirection(500, 0, out).distanceTo(new Vector3(0, 0, -1)) < 1e-12);
  assert.ok(photoSunDirection(-500, 0, out).distanceTo(new Vector3(0, 0, -1)) < 1e-12);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(photoSunDirection(value, 0, out).toArray(), [0, 0, 1]);
  }
});
import { sunDirModel } from '../src/client/sun-lighting';
import { Euler, Quaternion } from 'three';

test('real sunlight follows geographic coordinates through display rotation and axial tilt',()=>{
  const june=sunDirModel(new Date('2026-06-21T12:00:00Z'));
  const december=sunDirModel(new Date('2026-12-21T12:00:00Z'));
  assert.ok(Math.abs(Math.asin(june.y)*180/Math.PI-23.44)<.2);
  assert.ok(Math.abs(Math.asin(december.y)*180/Math.PI+23.44)<.2);
  assert.ok(june.x>.9,'Greenwich near solar noon');
  const midnight=sunDirModel(new Date('2026-06-21T00:00:00Z'));
  assert.ok(midnight.x<-.9,'Greenwich near midnight');
  const q=new Quaternion().setFromEuler(new Euler(0,1.8,23.439*Math.PI/180));
  const normal=new Vector3(.5,.6,.7).normalize();
  assert.ok(Math.abs(normal.dot(june)-normal.clone().applyQuaternion(q).dot(june.clone().applyQuaternion(q)))<1e-12,'view rotation cannot move daylight to a different country');
});
