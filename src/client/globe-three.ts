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
  /** 0..1 cloud coverage / opacity */
  getCloudAmount: () => number;
  getMarkers: () => LatLngMarker[];
  getTle: () => [string, string] | null;
  onIssUpdate?: (iss: IssSnapshot | null) => void;
};

const EARTH_RADIUS_KM = 6371;
/** Dense samples for closed inertial orbit ellipse (same GMST → true closed ring) */
const ORBIT_SAMPLES = 256;
const TEX = "https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img";
const CLOUD_TEX =
  "https://cdn.jsdelivr.net/gh/turban/webgl-earth@master/images/fair_clouds_4k.png";
const CLOUD_TEX_FALLBACK =
  "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/earth_clouds_1024.png";

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

/** ECEF sun unit vector → our globe axes (x=lon0, y=north, z=-lon90). */
function sunDirModel(date: Date, out = new THREE.Vector3()) {
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

function waterToSoftRoughnessMap(waterTex: THREE.Texture) {
  const img = waterTex.image as CanvasImageSource & { width: number; height: number };
  const c = document.createElement("canvas");
  c.width = img.width || 1024;
  c.height = img.height || 512;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const water = d[i]! / 255;
    const rough = 1 - water * 0.14;
    const v = Math.round(rough * 255);
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.NoColorSpace;
  map.anisotropy = 4;
  map.needsUpdate = true;
  return map;
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
  const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 100);
  camera.position.set(0, 0.22, 3.55);

  // Pivot: Earth rotates under a *world-fixed* sun (terminator stays real)
  const root = new THREE.Group();
  scene.add(root);

  // --- Lighting: soft night ambient + strong sun (Google Earth–like day) ---
  const ambient = new THREE.AmbientLight(0x8aa0c0, 0.42);
  scene.add(ambient);
  const hemi = new THREE.HemisphereLight(0xb8d4ff, 0x0b1224, 0.22);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff6e8, 2.0);
  sun.position.set(5, 0, 0);
  scene.add(sun);
  scene.add(sun.target);

  const fill = new THREE.DirectionalLight(0x8ecaff, 0.18);
  fill.position.set(-4, -1, -2);
  scene.add(fill);

  const sunDir = new THREE.Vector3(1, 0, 0);
  // Earth
  const earthGroup = new THREE.Group();
  earthGroup.scale.setScalar(0.9);
  root.add(earthGroup);

  const earthGeo = new THREE.SphereGeometry(1, 96, 96);
  // Day/night blend via onBeforeCompile — soft terminator, lit day, soft night + city lights
  const earthMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0,
  });

  const dayNightUniforms = {
    uNightMap: { value: null as THREE.Texture | null },
    uSunDir: { value: sunDir.clone() },
    uDayBoost: { value: 1.15 },
    uNightFloor: { value: 0.22 },
    uCityBoost: { value: 1.35 },
    uTermSoft: { value: 0.28 },
  };

  earthMat.onBeforeCompile = (shader) => {
    shader.uniforms.uNightMap = dayNightUniforms.uNightMap;
    shader.uniforms.uSunDir = dayNightUniforms.uSunDir;
    shader.uniforms.uDayBoost = dayNightUniforms.uDayBoost;
    shader.uniforms.uNightFloor = dayNightUniforms.uNightFloor;
    shader.uniforms.uCityBoost = dayNightUniforms.uCityBoost;
    shader.uniforms.uTermSoft = dayNightUniforms.uTermSoft;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vDnNormal;
        varying vec2 vDnUv;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vDnNormal = normalize(mat3(modelMatrix) * objectNormal);
        vDnUv = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D uNightMap;
        uniform vec3 uSunDir;
        uniform float uDayBoost;
        uniform float uNightFloor;
        uniform float uCityBoost;
        uniform float uTermSoft;
        varying vec3 vDnNormal;
        varying vec2 vDnUv;`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float ndl = dot(normalize(vDnNormal), normalize(uSunDir));
        float dayF = smoothstep(-uTermSoft, uTermSoft * 1.15, ndl);
        vec3 dayCol = diffuseColor.rgb * uDayBoost;
        vec3 nightTex = texture2D(uNightMap, vDnUv).rgb;
        vec3 nightCol = nightTex * uCityBoost + vec3(0.02, 0.04, 0.08);
        nightCol = max(nightCol, vec3(uNightFloor * 0.35));
        // Soft mix: day side vibrant, night soft with lights — never pure black
        diffuseColor.rgb = mix(nightCol, dayCol, dayF);
        // Keep a hint of city lights near terminator dusk
        diffuseColor.rgb += nightTex * uCityBoost * 0.12 * (1.0 - dayF) * dayF * 4.0;`,
      );
  };
  earthMat.customProgramCacheKey = () => "earth-day-night-v2";

  const earth = new THREE.Mesh(earthGeo, earthMat);
  earthGroup.add(earth);

  const loader = new THREE.TextureLoader();

  loader.load(`${TEX}/earth-blue-marble.jpg`, (day) => {
    day.colorSpace = THREE.SRGBColorSpace;
    day.anisotropy = 8;
    earthMat.map = day;
    earthMat.needsUpdate = true;
  });
  loader.load(`${TEX}/earth-night.jpg`, (night) => {
    night.colorSpace = THREE.SRGBColorSpace;
    night.anisotropy = 8;
    dayNightUniforms.uNightMap.value = night;
    earthMat.needsUpdate = true;
  });
  loader.load(`${TEX}/earth-water.png`, (waterTex) => {
    earthMat.roughnessMap = waterToSoftRoughnessMap(waterTex);
    earthMat.roughness = 1;
    earthMat.metalness = 0;
    earthMat.needsUpdate = true;
    waterTex.dispose();
  });

  // --- Clouds: denser / more realistic + soft shadow shell ---
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    emissive: 0x334155,
    emissiveIntensity: 0.04,
    side: THREE.DoubleSide,
  });
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.018, 96, 96), cloudMat);
  clouds.rotation.y = Math.random() * Math.PI * 2;
  clouds.rotation.z = (Math.random() - 0.5) * 0.06;
  earthGroup.add(clouds);

  // Soft ground shadow from clouds (dark multiply-ish shell just above surface)
  const cloudShadowMat = new THREE.MeshBasicMaterial({
    color: 0x0b1220,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    blending: THREE.MultiplyBlending,
  });
  const cloudShadow = new THREE.Mesh(new THREE.SphereGeometry(1.006, 64, 64), cloudShadowMat);
  cloudShadow.rotation.copy(clouds.rotation);
  earthGroup.add(cloudShadow);

  const cloudDrift = 0.0001 + Math.random() * 0.00006;
  const cloudDrift2 = -0.00004 - Math.random() * 0.00003;

  let cloudsReady = false;
  function applyCloudTex(tex: THREE.Texture) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    cloudMat.map = tex;
    cloudMat.alphaMap = tex;
    cloudMat.needsUpdate = true;
    cloudShadowMat.alphaMap = tex;
    cloudShadowMat.needsUpdate = true;
    cloudsReady = true;
  }

  function applyCloudAmount(amount: number) {
    const a = Math.min(1, Math.max(0, amount));
    const on = a > 0.02 && (cloudsReady || !!cloudMat.map);
    clouds.visible = on;
    clouds2.visible = on;
    cloudShadow.visible = on;
    cloudMat.opacity = 0.15 + a * 0.75; // 0.15..0.90
    cloudMat2.opacity = 0.05 + a * 0.4; // 0.05..0.45
    cloudShadowMat.opacity = a * 0.32;
  }

  loader.load(
    CLOUD_TEX,
    applyCloudTex,
    undefined,
    () => {
      loader.load(CLOUD_TEX_FALLBACK, applyCloudTex, undefined, () => {
        clouds.visible = false;
        cloudShadow.visible = false;
      });
    },
  );

  // Second wispy cloud layer for depth
  const cloudMat2 = cloudMat.clone();
  cloudMat2.opacity = 0.35;
  const clouds2 = new THREE.Mesh(new THREE.SphereGeometry(1.022, 64, 64), cloudMat2);
  clouds2.rotation.y = Math.random() * Math.PI * 2;
  earthGroup.add(clouds2);
  loader.load(CLOUD_TEX_FALLBACK, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    cloudMat2.map = tex;
    cloudMat2.alphaMap = tex;
    cloudMat2.needsUpdate = true;
  });

  // Fresnel atmosphere (subtle)
  const atmosUniforms = {
    uGlowColor: { value: new THREE.Color(0x1e3a5f) },
    uRimColor: { value: new THREE.Color(0x7dd3fc) },
    uIntensity: { value: 0.48 },
    uPower: { value: 3.6 },
    uPulse: { value: 0 },
  };
  const atmosMat = new THREE.ShaderMaterial({
    uniforms: atmosUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uGlowColor;
      uniform vec3 uRimColor;
      uniform float uIntensity;
      uniform float uPower;
      uniform float uPulse;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float fresnel = pow(1.0 - abs(dot(viewDir, normalize(vNormal))), uPower);
        fresnel = clamp(fresnel * (uIntensity + uPulse), 0.0, 1.0);
        vec3 col = mix(uGlowColor, uRimColor, fresnel);
        gl_FragColor = vec4(col, fresnel * 0.4);
      }
    `,
  });
  earthGroup.add(new THREE.Mesh(new THREE.SphereGeometry(1.03, 64, 64), atmosMat));

  const hazeMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x172554) },
      uPulse: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uPulse;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float fresnel = pow(1.0 - abs(dot(viewDir, normalize(vNormal))), 3.4);
        gl_FragColor = vec4(uColor, fresnel * (0.1 + uPulse * 0.4));
      }
    `,
  });
  earthGroup.add(new THREE.Mesh(new THREE.SphereGeometry(1.055, 48, 48), hazeMat));

  // Visitor markers
  const markerGroup = new THREE.Group();
  earthGroup.add(markerGroup);
  const markerGeo = new THREE.SphereGeometry(1, 12, 12);
  const markerMatSelf = new THREE.MeshStandardMaterial({
    color: 0xbae6fd,
    emissive: 0x22d3ee,
    emissiveIntensity: 0.45,
    roughness: 0.45,
    metalness: 0.25,
  });
  const markerMatOther = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    emissive: 0x0284c7,
    emissiveIntensity: 0.28,
    roughness: 0.5,
    metalness: 0.2,
  });
  const markerPool: THREE.Mesh[] = [];

  function syncMarkers(list: LatLngMarker[]) {
    while (markerPool.length < list.length) {
      const m = new THREE.Mesh(markerGeo, markerMatOther);
      markerPool.push(m);
      markerGroup.add(m);
    }
    for (let i = 0; i < markerPool.length; i++) {
      const mesh = markerPool[i]!;
      const data = list[i];
      if (!data) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.material = data.self ? markerMatSelf : markerMatOther;
      mesh.scale.setScalar(Math.max(0.006, Math.min(0.018, data.size * 0.14)));
      latLngAltToVec3(data.lat, data.lng, 12, mesh.position);
    }
  }

  // Orbit — dense LineLoop, period from TLE mean motion (closes cleanly)
  const orbitPositions = new Float32Array(ORBIT_SAMPLES * 3);
  const orbitGeo = new THREE.BufferGeometry();
  orbitGeo.setAttribute("position", new THREE.BufferAttribute(orbitPositions, 3));
  const orbitMat = new THREE.LineBasicMaterial({
    color: 0x22d3ee,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });
  const orbitLine = new THREE.LineLoop(orbitGeo, orbitMat);
  orbitLine.renderOrder = 10;
  orbitLine.frustumCulled = false;
  earthGroup.add(orbitLine);

  const orbitGlowPositions = new Float32Array(ORBIT_SAMPLES * 3);
  const orbitGlowGeo = new THREE.BufferGeometry();
  orbitGlowGeo.setAttribute("position", new THREE.BufferAttribute(orbitGlowPositions, 3));
  const orbitGlowMat = new THREE.LineBasicMaterial({
    color: 0xf97316,
    transparent: true,
    opacity: 0.4,
    depthTest: false,
    depthWrite: false,
  });
  const orbitGlow = new THREE.LineLoop(orbitGlowGeo, orbitGlowMat);
  orbitGlow.renderOrder = 9;
  orbitGlow.frustumCulled = false;
  earthGroup.add(orbitGlow);

  const iss = createIssModel();
  iss.scale.setScalar(0.028);
  earthGroup.add(iss);

  const issGlowTex = makeGlowSprite();
  const issGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: issGlowTex,
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  issGlow.scale.setScalar(0.07);
  earthGroup.add(issGlow);

  let satrec: satellite.SatRec | null = null;
  let lastTleKey = "";
  let lastOrbitBuild = 0;
  let orbitReady = false;
  let lastIssEmit = 0;
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

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

  function orbitPeriodMs(rec: satellite.SatRec) {
    // satrec.no = mean motion (rad/min)
    const no = rec.no;
    if (!no || !Number.isFinite(no) || no <= 0) return 92.9 * 60 * 1000;
    return ((2 * Math.PI) / no) * 60 * 1000;
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
      velocity = Math.sqrt(
        velocityEci.x * velocityEci.x +
          velocityEci.y * velocityEci.y +
          velocityEci.z * velocityEci.z,
      );
    }
    return { latitude, longitude, altitude, velocity };
  }

  function eciToGlobe(pos: satellite.EciVec3<number>, gmst: number, radiusScale: number, target: THREE.Vector3) {
    // Freeze Earth rotation (same gmst for all samples) → closed orbital ellipse, no ground-track chord
    const ecf = satellite.eciToEcf(pos, gmst);
    const len = Math.sqrt(ecf.x * ecf.x + ecf.y * ecf.y + ecf.z * ecf.z) || 1;
    const s = radiusScale / len;
    // ECEF → our axes (x=lon0, y=north, z=-lon90)
    return target.set(ecf.x * s, ecf.z * s, -ecf.y * s);
  }

  function rebuildOrbit(now: Date) {
    const rec = ensureSatrec();
    if (!rec) return;
    const periodMs = orbitPeriodMs(rec);
    const gmst0 = satellite.gstime(now);
    let firstSet = false;
    let fx = 0, fy = 0, fz = 0, gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < ORBIT_SAMPLES; i++) {
      const t = new Date(now.getTime() + (i / ORBIT_SAMPLES) * periodMs);
      const pv = satellite.propagate(rec, t);
      if (!pv || !pv.position || typeof pv.position === "boolean") {
        if (firstSet) {
          orbitPositions[i * 3] = fx;
          orbitPositions[i * 3 + 1] = fy;
          orbitPositions[i * 3 + 2] = fz;
          orbitGlowPositions[i * 3] = gx;
          orbitGlowPositions[i * 3 + 1] = gy;
          orbitGlowPositions[i * 3 + 2] = gz;
        }
        continue;
      }
      const pos = pv.position as satellite.EciVec3<number>;
      // Mean radius ~ Earth + ~420km in satrec units (km)
      const rKm = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
      const altFrac = Math.max(0.02, (rKm - EARTH_RADIUS_KM) / EARTH_RADIUS_KM);
      eciToGlobe(pos, gmst0, 1 + altFrac, tmp);
      orbitPositions[i * 3] = tmp.x;
      orbitPositions[i * 3 + 1] = tmp.y;
      orbitPositions[i * 3 + 2] = tmp.z;
      eciToGlobe(pos, gmst0, 1 + altFrac + 0.012, tmp2);
      orbitGlowPositions[i * 3] = tmp2.x;
      orbitGlowPositions[i * 3 + 1] = tmp2.y;
      orbitGlowPositions[i * 3 + 2] = tmp2.z;
      if (!firstSet) {
        firstSet = true;
        fx = tmp.x; fy = tmp.y; fz = tmp.z;
        gx = tmp2.x; gy = tmp2.y; gz = tmp2.z;
      }
    }
    // Exact closure for LineLoop
    if (firstSet) {
      orbitPositions[(ORBIT_SAMPLES - 1) * 3] = orbitPositions[0]!;
      orbitPositions[(ORBIT_SAMPLES - 1) * 3 + 1] = orbitPositions[1]!;
      orbitPositions[(ORBIT_SAMPLES - 1) * 3 + 2] = orbitPositions[2]!;
      orbitGlowPositions[(ORBIT_SAMPLES - 1) * 3] = orbitGlowPositions[0]!;
      orbitGlowPositions[(ORBIT_SAMPLES - 1) * 3 + 1] = orbitGlowPositions[1]!;
      orbitGlowPositions[(ORBIT_SAMPLES - 1) * 3 + 2] = orbitGlowPositions[2]!;
    }
    (orbitGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (orbitGlowGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    orbitGeo.computeBoundingSphere();
    orbitGlowGeo.computeBoundingSphere();
    orbitReady = firstSet;
  }

  function updateSun(_date: Date) {
    // Bias sun toward the camera so the facing hemisphere is ~half lit (Google Earth–like).
    // Real UTC sun often puts day on the far side → tiny crescent; user OK moving sun for visibility.
    const cam = camera.position;
    // Front-facing key light with a soft offset (not dead-center specular)
    sunDir.set(cam.x + 0.55, cam.y + 0.35, cam.z + 0.15).normalize();
    dayNightUniforms.uSunDir.value.copy(sunDir);
    sun.position.copy(sunDir).multiplyScalar(6);
    sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld();
  }

  function resize() {
    const box = canvas.parentElement ?? canvas;
    const css = Math.max(
      1,
      Math.round(
        Math.min(box.clientWidth || 0, box.clientHeight || 0) || canvas.clientWidth || 520,
      ),
    );
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(css, css, false);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    camera.aspect = 1;
    camera.updateProjectionMatrix();
  }
  resize();

  let phi = 0;
  let raf = 0;
  let running = true;
  const onResize = () => resize();
  window.addEventListener("resize", onResize);
  const ro =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
  ro?.observe(canvas.parentElement ?? canvas);

  function frame(time: number) {
    if (!running) return;
    raf = requestAnimationFrame(frame);

    syncMarkers(opts.getMarkers());
    const now = new Date();
    updateSun(now);

    // Orbit rebuild whenever TLE is available (not gated on current prop success)
    if (ensureSatrec() && (time - lastOrbitBuild > 20_000 || lastOrbitBuild === 0)) {
      try {
        rebuildOrbit(now);
        lastOrbitBuild = time;
      } catch (err) {
        console.warn("rebuildOrbit failed", err);
      }
    }
    orbitLine.visible = orbitReady;
    orbitGlow.visible = orbitReady;

    const p = propagate(now);
    if (p) {
      latLngAltToVec3(p.latitude, p.longitude, p.altitude, iss.position);
      issGlow.position.copy(iss.position);

      const ahead = propagate(new Date(now.getTime() + 20_000));
      if (ahead) {
        latLngAltToVec3(ahead.latitude, ahead.longitude, ahead.altitude, tmp);
        iss.up.copy(iss.position).normalize();
        iss.lookAt(tmp);
        iss.rotateX(Math.PI / 2);
      }

      issGlow.scale.setScalar(0.065 + 0.012 * Math.sin(time * 0.004));

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
    } else {
      iss.visible = false;
      issGlow.visible = false;
      if (time - lastIssEmit > 2000) {
        lastIssEmit = time;
        opts.onIssUpdate?.(null);
      }
    }

    applyCloudAmount(opts.getCloudAmount());
    clouds.rotation.y += cloudDrift;
    clouds2.rotation.y += cloudDrift2;
    cloudShadow.rotation.y = clouds.rotation.y;
    cloudShadow.rotation.z = clouds.rotation.z;

    phi += opts.getRotationSpeed();
    root.rotation.y = phi;
    root.rotation.x = 0.18;

    const pulse = 0.012 * Math.sin(time * 0.001);
    atmosUniforms.uPulse.value = pulse;
    (hazeMat.uniforms.uPulse as { value: number }).value = pulse;

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      orbitGeo.dispose();
      orbitGlowGeo.dispose();
      earthGeo.dispose();
      earthMat.dispose();
      markerGeo.dispose();
      markerMatSelf.dispose();
      markerMatOther.dispose();
      issGlowTex.dispose();
      cloudMat.dispose();
      cloudMat2.dispose();
      cloudShadowMat.dispose();
      renderer.dispose();
    },
    resize,
  };
}
