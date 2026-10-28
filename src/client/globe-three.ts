import * as THREE from "three";
import * as satellite from "satellite.js";
import { createIssModel } from "./iss-model";

export type LatLngMarker = {
  id: string;
  lat: number;
  lng: number;
  size: number;
  self?: boolean;
};

export type IssSnapshot = {
  latitude: number;
  longitude: number;
  altitude: number;
  velocity: number;
};

type GlobeThreeOptions = {
  canvas: HTMLCanvasElement;
  getRotationSpeed: () => number;
  getMarkers: () => LatLngMarker[];
  getTle: () => [string, string] | null;
  onIssUpdate?: (iss: IssSnapshot | null) => void;
};

const EARTH_RADIUS_KM = 6371;
const ORBIT_SAMPLES = 120;
const ORBIT_PERIOD_MIN = 92.9;

function latLngAltToVec3(lat: number, lng: number, altKm: number, target = new THREE.Vector3()) {
  const r = 1 + altKm / EARTH_RADIUS_KM;
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  target.set(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
  return target;
}

function makeGlowSprite(size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255, 220, 150, 1)");
  g.addColorStop(0.2, "rgba(251, 146, 60, 0.7)");
  g.addColorStop(0.45, "rgba(34, 211, 238, 0.28)");
  g.addColorStop(1, "rgba(14, 165, 233, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createGlobeThree(opts: GlobeThreeOptions) {
  const { canvas } = opts;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 0.35, 2.85);

  const root = new THREE.Group();
  scene.add(root);

  // Lights
  scene.add(new THREE.AmbientLight(0x8ecaff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.35);
  key.position.set(4, 2, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x38bdf8, 0.55);
  rim.position.set(-3, -1, -2);
  scene.add(rim);

  // Earth
  const earthGroup = new THREE.Group();
  root.add(earthGroup);

  const earthGeo = new THREE.SphereGeometry(1, 96, 96);
  const earthMat = new THREE.MeshStandardMaterial({
    color: 0x0b1224,
    roughness: 0.85,
    metalness: 0.15,
    emissive: 0x071018,
    emissiveIntensity: 0.4,
  });
  const earth = new THREE.Mesh(earthGeo, earthMat);
  earthGroup.add(earth);

  const loader = new THREE.TextureLoader();
  loader.load(
    "https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img/earth-night.jpg",
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      earthMat.map = tex;
      earthMat.color.set(0xffffff);
      earthMat.emissiveMap = tex;
      earthMat.emissive.set(0x335577);
      earthMat.emissiveIntensity = 0.85;
      earthMat.needsUpdate = true;
    },
    undefined,
    () => {
      /* keep solid fallback */
    },
  );

  // Atmosphere shells
  const atmos = new THREE.Mesh(
    new THREE.SphereGeometry(1.035, 64, 64),
    new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.09,
      side: THREE.BackSide,
    }),
  );
  earthGroup.add(atmos);

  const atmosOuter = new THREE.Mesh(
    new THREE.SphereGeometry(1.12, 48, 48),
    new THREE.MeshBasicMaterial({
      color: 0x1d4ed8,
      transparent: true,
      opacity: 0.045,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  earthGroup.add(atmosOuter);

  // Subtle grid / equator ring
  const equ = new THREE.Mesh(
    new THREE.TorusGeometry(1.002, 0.0018, 8, 128),
    new THREE.MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.22,
    }),
  );
  equ.rotation.x = Math.PI / 2;
  earthGroup.add(equ);

  // Visitor markers
  const markerGroup = new THREE.Group();
  earthGroup.add(markerGroup);
  const markerGeo = new THREE.SphereGeometry(1, 12, 12);
  const markerMatSelf = new THREE.MeshStandardMaterial({
    color: 0xa5f3fc,
    emissive: 0x22d3ee,
    emissiveIntensity: 1.2,
    roughness: 0.3,
    metalness: 0.4,
  });
  const markerMatOther = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    emissive: 0x0284c7,
    emissiveIntensity: 0.9,
    roughness: 0.35,
    metalness: 0.35,
  });
  const markerPool: THREE.Mesh[] = [];

  function syncMarkers(list: LatLngMarker[]) {
    while (markerPool.length < list.length) {
      const m = new THREE.Mesh(markerGeo, markerMatOther);
      markerPool.push(m);
      markerGroup.add(m);
    }
    for (let i = 0; i < markerPool.length; i++) {
      const mesh = markerPool[i];
      const data = list[i];
      if (!data) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.material = data.self ? markerMatSelf : markerMatOther;
      const s = Math.max(0.012, Math.min(0.04, data.size * 0.35));
      mesh.scale.setScalar(s);
      latLngAltToVec3(data.lat, data.lng, 12, mesh.position);
    }
  }

  // Orbit line
  const orbitPositions = new Float32Array(ORBIT_SAMPLES * 3);
  const orbitGeo = new THREE.BufferGeometry();
  orbitGeo.setAttribute("position", new THREE.BufferAttribute(orbitPositions, 3));
  const orbitMat = new THREE.LineBasicMaterial({
    color: 0x22d3ee,
    transparent: true,
    opacity: 0.85,
    linewidth: 1,
  });
  const orbitLine = new THREE.LineLoop(orbitGeo, orbitMat);
  earthGroup.add(orbitLine);

  // Soft glow ribbon (slightly larger, faded)
  const orbitGlowPositions = new Float32Array(ORBIT_SAMPLES * 3);
  const orbitGlowGeo = new THREE.BufferGeometry();
  orbitGlowGeo.setAttribute("position", new THREE.BufferAttribute(orbitGlowPositions, 3));
  const orbitGlow = new THREE.LineLoop(
    orbitGlowGeo,
    new THREE.LineBasicMaterial({
      color: 0xf97316,
      transparent: true,
      opacity: 0.28,
    }),
  );
  earthGroup.add(orbitGlow);

  // ISS
  const iss = createIssModel();
  iss.scale.setScalar(0.028);
  earthGroup.add(iss);

  const issGlowTex = makeGlowSprite();
  const issGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: issGlowTex,
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  issGlow.scale.setScalar(0.18);
  earthGroup.add(issGlow);

  let satrec: satellite.SatRec | null = null;
  let lastTleKey = "";
  let lastOrbitBuild = 0;
  let lastIssEmit = 0;
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  function ensureSatrec() {
    const tle = opts.getTle();
    if (!tle) {
      satrec = null;
      return null;
    }
    const key = tle[0] + tle[1];
    if (key !== lastTleKey || !satrec) {
      satrec = satellite.twoline2satrec(tle[0], tle[1]);
      lastTleKey = key;
      lastOrbitBuild = 0;
    }
    return satrec;
  }

  function propagate(date: Date) {
    const rec = ensureSatrec();
    if (!rec) return null;
    const pv = satellite.propagate(rec, date);
    if (!pv || !pv.position || typeof pv.position === "boolean") return null;
    const positionEci = pv.position as satellite.EciVec3<number>;
    const velocityEci = pv.velocity as satellite.EciVec3<number> | undefined;
    const gmst = satellite.gstime(date);
    const gd = satellite.eciToGeodetic(positionEci, gmst);
    const latitude = satellite.degreesLat(gd.latitude);
    const longitude = satellite.degreesLong(gd.longitude);
    const altitude = gd.height;
    let velocity = 0;
    if (velocityEci) {
      velocity =
        Math.sqrt(
          velocityEci.x * velocityEci.x +
            velocityEci.y * velocityEci.y +
            velocityEci.z * velocityEci.z,
        ) * 1000; // km/s → m/s? satellite.js velocity is km/s
      // Keep as km/s * 1000 to match WhereTheISS (m/s) for panel: velocity_km_s * 1000
      velocity = velocity * 1000;
    }
    return { latitude, longitude, altitude, velocity, positionEci, velocityEci, gmst };
  }

  function rebuildOrbit(now: Date) {
    const periodMs = ORBIT_PERIOD_MIN * 60 * 1000;
    for (let i = 0; i < ORBIT_SAMPLES; i++) {
      const t = new Date(now.getTime() + (i / ORBIT_SAMPLES) * periodMs);
      const p = propagate(t);
      if (!p) continue;
      latLngAltToVec3(p.latitude, p.longitude, p.altitude, tmp);
      orbitPositions[i * 3] = tmp.x;
      orbitPositions[i * 3 + 1] = tmp.y;
      orbitPositions[i * 3 + 2] = tmp.z;
      // glow ribbon slightly outside
      latLngAltToVec3(p.latitude, p.longitude, p.altitude + 40, tmp2);
      orbitGlowPositions[i * 3] = tmp2.x;
      orbitGlowPositions[i * 3 + 1] = tmp2.y;
      orbitGlowPositions[i * 3 + 2] = tmp2.z;
    }
    orbitGeo.attributes.position.needsUpdate = true;
    orbitGlowGeo.attributes.position.needsUpdate = true;
    orbitGeo.computeBoundingSphere();
  }

  function resize() {
    const w = canvas.clientWidth || 520;
    const h = canvas.clientHeight || 520;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();

  let phi = 0;
  let raf = 0;
  let running = true;

  const onResize = () => resize();
  window.addEventListener("resize", onResize);

  function frame(time: number) {
    if (!running) return;
    raf = requestAnimationFrame(frame);

    syncMarkers(opts.getMarkers());

    const now = new Date();
    const p = propagate(now);
    if (p) {
      if (time - lastOrbitBuild > 15_000 || lastOrbitBuild === 0) {
        rebuildOrbit(now);
        lastOrbitBuild = time;
      }
      latLngAltToVec3(p.latitude, p.longitude, p.altitude, iss.position);
      issGlow.position.copy(iss.position);

      // Orient along velocity: next sample ~20s ahead
      const ahead = propagate(new Date(now.getTime() + 20_000));
      if (ahead) {
        latLngAltToVec3(ahead.latitude, ahead.longitude, ahead.altitude, tmp);
        iss.up.copy(iss.position).normalize();
        iss.lookAt(tmp);
        // solar wings roughly face sun-ish: slight roll
        iss.rotateX(Math.PI / 2);
      }

      const pulse = 0.16 + 0.04 * Math.sin(time * 0.004);
      issGlow.scale.setScalar(pulse);

      if (time - lastIssEmit > 1000) {
        lastIssEmit = time;
        opts.onIssUpdate?.({
          latitude: p.latitude,
          longitude: p.longitude,
          altitude: p.altitude,
          velocity: p.velocity,
        });
      }
      iss.visible = true;
      issGlow.visible = true;
      orbitLine.visible = true;
      orbitGlow.visible = true;
    } else {
      iss.visible = false;
      issGlow.visible = false;
      orbitLine.visible = false;
      orbitGlow.visible = false;
      if (time - lastIssEmit > 2000) {
        lastIssEmit = time;
        opts.onIssUpdate?.(null);
      }
    }

    phi += opts.getRotationSpeed();
    root.rotation.y = phi;
    root.rotation.x = 0.18;

    // gentle atmosphere pulse
    (atmos.material as THREE.MeshBasicMaterial).opacity = 0.07 + 0.025 * Math.sin(time * 0.001);

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      orbitGeo.dispose();
      orbitGlowGeo.dispose();
      earthGeo.dispose();
      earthMat.dispose();
      markerGeo.dispose();
      markerMatSelf.dispose();
      markerMatOther.dispose();
      issGlowTex.dispose();
      renderer.dispose();
    },
    resize,
  };
}
