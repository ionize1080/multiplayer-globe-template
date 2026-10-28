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

export type CloudMode = "animated" | "live";

export type CloudSource =
  | { mode: "animated" }
  | { mode: "live"; url: string; date?: string };

type GlobeThreeOptions = {
  canvas: HTMLCanvasElement;
  getRotationSpeed: () => number;
  /** 0..1 cloud coverage / opacity */
  getCloudAmount: () => number;
  getMarkers: () => LatLngMarker[];
  getTle: () => [string, string] | null;
  onIssUpdate?: (iss: IssSnapshot | null) => void;
  /** ISS model + orbit + glows (default true) */
  getShowIss?: () => boolean;
  /** Starlink Points cloud (default false) */
  getShowStarlink?: () => boolean;
  /** Drawn Starlink count target (500–8000); default ~2200 */
  getStarlinkDensity?: () => number;
  /** Starlink point opacity (0.05–1); default ~0.42 */
  getStarlinkBrightness?: () => number;
  /** "rotate" = auto-spin; "drag" = pointer orbit (mutually exclusive) */
  getInteractionMode?: () => "rotate" | "drag";
};

export type StarlinkTlePair = [string, string];

const EARTH_RADIUS_KM = 6371;
/** Dense samples for closed inertial orbit ellipse (same GMST → true closed ring) */
const ORBIT_SAMPLES = 256;
const TEX = "https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img";
const CLOUD_TEX =
  "https://cdn.jsdelivr.net/gh/turban/webgl-earth@master/images/fair_clouds_4k.png";
const CLOUD_TEX_FALLBACK =
  "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/earth_clouds_1024.png";
/** Cache-bust / Aura verify marker — must appear in deployed /dist/index.js */
export const LIVE_CLOUDS_BUILD = "c7b-20261028-wisp-fill";
/** ISS far-side dim + visitor ripple markers */
export const GLOBE_FX_BUILD = "fx5-20261028-starlink-sliders-dragfix";

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

/** Soft bright core for visitor IP markers (replaces spheres). */
function makeDotTexture(size = 64) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255, 255, 255, 1)");
  g.addColorStop(0.18, "rgba(255, 236, 200, 0.95)");
  g.addColorStop(0.4, "rgba(251, 191, 36, 0.55)");
  g.addColorStop(0.7, "rgba(245, 158, 11, 0.12)");
  g.addColorStop(1, "rgba(245, 158, 11, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Thin concentric ring for expanding ripple pulses. */
function makeRingTexture(size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const cx = size / 2;
  const r = size * 0.38;
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.arc(cx, cx, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 220, 160, 0.95)";
  ctx.lineWidth = size * 0.045;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cx, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(251, 146, 60, 0.35)";
  ctx.lineWidth = size * 0.09;
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Soft limb fade vs camera (for markers). ISS uses real depthTest occlusion;
 * this helper only softens near the limb / far hemisphere for non-occluded draws.
 * Returns ~1 facing camera, ~0 when fully behind.
 */
function farSideBrightness(worldPos: THREE.Vector3, cameraPos: THREE.Vector3) {
  const len = worldPos.length();
  if (len < 1e-6) return 1;
  const facing =
    (worldPos.x * cameraPos.x + worldPos.y * cameraPos.y + worldPos.z * cameraPos.z) /
    (len * (cameraPos.length() || 1));
  return THREE.MathUtils.smoothstep(facing, -0.05, 0.35);
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
  // R3 crop fix: z 2.65→3.05 + y→0 so haze/orbit clear frustum; FOV stays 44
  // (Aura's 38–40 FOV would tighten the cone — Alan: pull back instead)
  const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 100);
  camera.position.set(0, 0, 3.05);

  // Pivot: Earth rotates under a *world-fixed* sun (terminator stays real)
  const root = new THREE.Group();
  scene.add(root);

  // --- Lighting: soft night ambient + strong sun (Google Earth–like day) ---
  const ambient = new THREE.AmbientLight(0x7a90b0, 0.48);
  scene.add(ambient);
  const hemi = new THREE.HemisphereLight(0xb8d4ff, 0x0b1224, 0.22);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffe8c8, 2.25);
  sun.position.set(5, 0, 0);
  scene.add(sun);
  scene.add(sun.target);

  const fill = new THREE.DirectionalLight(0x8ecaff, 0.18);
  fill.position.set(-4, -1, -2);
  scene.add(fill);

  const sunDir = new THREE.Vector3(1, 0, 0);
  // Earth
  const earthGroup = new THREE.Group();
  earthGroup.scale.setScalar(1.0);
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
    uDayBoost: { value: 1.38 },
    uNightFloor: { value: 0.28 },
    uCityBoost: { value: 2.8 },
    uTermSoft: { value: 0.32 },
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
        float dayF = smoothstep(-uTermSoft, uTermSoft * 1.2, ndl);
        // Warm, slightly saturated day (Google Earth–like)
        vec3 dayCol = diffuseColor.rgb * uDayBoost;
        dayCol = mix(dayCol, dayCol * vec3(1.08, 1.02, 0.92), 0.35);
        dayCol = mix(vec3(dot(dayCol, vec3(0.299, 0.587, 0.114))), dayCol, 1.18);
        vec3 nightTex = texture2D(uNightMap, vDnUv).rgb;
        // City lights dominate night; soft blue floor so it never goes dead black
        vec3 cities = nightTex * nightTex * uCityBoost; // square to punch bright pixels
        vec3 nightCol = cities + vec3(0.035, 0.05, 0.1) * uNightFloor;
        nightCol = max(nightCol, vec3(uNightFloor * 0.4));
        diffuseColor.rgb = mix(nightCol, dayCol, dayF);
        // Dusk city bleed near terminator
        diffuseColor.rgb += cities * 0.35 * (1.0 - dayF) * dayF * 4.0;`,
      );
  };
  earthMat.customProgramCacheKey = () => "earth-day-night-r2";

  const earth = new THREE.Mesh(earthGeo, earthMat);
  earthMat.depthWrite = true;
  earthMat.depthTest = true;
  earth.renderOrder = 0;
  earthGroup.add(earth);

  const loader = new THREE.TextureLoader();

  loader.load(`${TEX}/earth-blue-marble.jpg`, (day) => {
    day.colorSpace = THREE.SRGBColorSpace;
    day.anisotropy = 8;
    earthMat.map = day;
    earthMat.needsUpdate = true;
  });
  const NIGHT_LIGHTS =
    "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/earth_lights_2048.png";
  const NIGHT_FALLBACK = `${TEX}/earth-night.jpg`;
  function applyNightMap(night: THREE.Texture) {
    night.colorSpace = THREE.SRGBColorSpace;
    night.anisotropy = 8;
    dayNightUniforms.uNightMap.value = night;
    // Also drive emissiveMap so MeshStandard path contributes city glow
    earthMat.emissiveMap = night;
    earthMat.emissive = new THREE.Color(0xfff4e0);
    earthMat.emissiveIntensity = 0.55;
    earthMat.needsUpdate = true;
  }
  loader.load(
    NIGHT_LIGHTS,
    applyNightMap,
    undefined,
    () => loader.load(NIGHT_FALLBACK, applyNightMap),
  );
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
    opacity: 0.58,
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

  const cloudDriftBase = 0.0001 + Math.random() * 0.00006;
  const cloudDrift2Base = -0.00004 - Math.random() * 0.00003;
  let cloudDrift = cloudDriftBase;
  let cloudDrift2 = cloudDrift2Base;
  const animatedCloudRotY = clouds.rotation.y;
  const animatedCloudRotZ = clouds.rotation.z;

  let cloudsReady = false;
  let cloudMode: CloudMode = "animated";
  let animatedCloudTex: THREE.Texture | null = null;
  let liveCloudTex: THREE.Texture | null = null;
  let liveLoadToken = 0;

  function bindCloudTex(tex: THREE.Texture, wrap: THREE.Wrapping = THREE.RepeatWrapping) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = wrap;
    cloudMat.map = tex;
    cloudMat.alphaMap = tex;
    // Live: unlit-ish white so TrueColor mask isn't muddy gray under night lighting
    if (cloudMode === "live") {
      cloudMat.color.set(0xffffff);
      cloudMat.emissive.set(0xffffff);
      cloudMat.emissiveIntensity = 0.9;
      cloudMat.roughness = 1;
      cloudMat.metalness = 0;
    } else {
      cloudMat.color.set(0xffffff);
      cloudMat.emissive.set(0x334155);
      cloudMat.emissiveIntensity = 0.04;
    }
    cloudMat.needsUpdate = true;
    cloudShadowMat.alphaMap = tex;
    cloudShadowMat.needsUpdate = true;
    cloudsReady = true;
  }

  function applyCloudTex(tex: THREE.Texture) {
    animatedCloudTex = tex;
    if (cloudMode === "animated") bindCloudTex(tex, THREE.RepeatWrapping);
  }

  function applyCloudAmount(amount: number) {
    const a = Math.min(1, Math.max(0, amount));
    const on = a > 0.02 && (cloudsReady || !!cloudMat.map);
    clouds.visible = on;
    // Live: global soft fair_clouds shell so orbital barcodes never read empty
    clouds2.visible = on;
    cloudShadow.visible = on;
    // Live: lighter veil so land stays readable at ~40–55%
    cloudMat.opacity =
      cloudMode === "live" ? 0.06 + a * 0.28 : 0.12 + a * 0.58;
    cloudMat2.opacity =
      cloudMode === "live"
        ? 0.22 + a * 0.34 // strong fair_clouds underlay hides barcodes
        : 0.04 + a * 0.32;
    cloudShadowMat.opacity = a * (cloudMode === "live" ? 0.08 : 0.32);
  }

  /** Yield so React can paint / Earth can keep spinning during heavy mask work. */
  function yieldFrame(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  /**
   * NASA true-color → bright WHITE cloud mask (c7).
   * Higher lum gate + gamma; fill dark vertical barcode bands with white wisps
   * + narrow neighbor alpha bleed (not ocean smear). Chunked with rAF yields.
   */
  async function trueColorToCloudMask(url: string): Promise<THREE.CanvasTexture> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`live cloud texture → ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.includes("png") && blob.size < 50_000) {
      throw new Error("live cloud texture empty/non-png");
    }
    await yieldFrame();
    const bmp = await createImageBitmap(blob);
    const w = bmp.width;
    const h = bmp.height;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    await yieldFrame();
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;
    const isNodata = new Uint8Array(w * h);
    const colNodata = new Float32Array(w);
    const colMeanA = new Float32Array(w);
    const colBright = new Float32Array(w);
    let opaqueN = 0;
    let nodataN = 0;
    const total = w * h;
    const ROW_CHUNK = 32;

    // Bright-white-only extract: kill mid-gray ocean veil / muddy speckles
    for (let y0 = 0; y0 < h; y0 += ROW_CHUNK) {
      const y1 = Math.min(h, y0 + ROW_CHUNK);
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) << 2;
          const r = d[i]!;
          const g = d[i + 1]!;
          const b = d[i + 2]!;
          const aIn = d[i + 3]!;
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          const sat = mx > 1 ? (mx - mn) / mx : 0;

          const nodata = aIn < 8 || lum < 10;
          if (nodata) {
            nodataN++;
            isNodata[y * w + x] = 1;
            colNodata[x]! += 1;
            d[i] = d[i + 1] = d[i + 2] = 255;
            d[i + 3] = 0;
            continue;
          }

          // Desert / land warm bright → suppress
          const warm = r - b > 28 && r > 130 && sat > 0.1;
          // Only fairly bright, low-sat pixels count as cloud
          let score =
            Math.min(1, Math.max(0, (lum - 145) / 75)) *
            Math.min(1, Math.max(0, 1.35 - sat * 2.4));
          if (warm) score *= 0.12;
          // Stronger gamma → punchy white cores, sparse thin haze
          score = Math.pow(Math.min(1, score), 0.55);
          const alpha = score < 0.08 ? 0 : Math.round(score * 255);
          d[i] = d[i + 1] = d[i + 2] = 255;
          d[i + 3] = alpha;
          colMeanA[x]! += alpha;
          if (alpha > 40) {
            opaqueN++;
            colBright[x]! += 1;
          }
        }
      }
      await yieldFrame();
    }

    const coverage = opaqueN / total;
    const nodataRatio = nodataN / total;
    if (coverage < 0.05) {
      throw new Error(`live cloud coverage too low (${(coverage * 100).toFixed(1)}%)`);
    }
    if (coverage > 0.85) {
      throw new Error(`live cloud coverage implausible (${(coverage * 100).toFixed(1)}%)`);
    }
    if (nodataRatio > 0.55) {
      throw new Error(`live cloud mosaic too incomplete (nodata ${(nodataRatio * 100).toFixed(0)}%)`);
    }

    for (let x = 0; x < w; x++) {
      colNodata[x]! /= h;
      colMeanA[x]! /= h;
      colBright[x]! /= h;
    }

    // Gap = elevated nodata OR dark/empty vertical band (low mean alpha vs neighbors)
    let medianNd = 0;
    let medianA = 0;
    {
      const sn = Array.from(colNodata).sort((a, b) => a - b);
      const sa = Array.from(colMeanA).sort((a, b) => a - b);
      medianNd = sn[Math.floor(sn.length / 2)]!;
      medianA = sa[Math.floor(sa.length / 2)]!;
    }
    const gapCol = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      let localMax = 0;
      for (let k = Math.max(0, x - 40); k <= Math.min(w - 1, x + 40); k++) {
        localMax = Math.max(localMax, colMeanA[k]!);
      }
      const darkStrip =
        localMax > 35 && colMeanA[x]! < localMax * 0.38 && colMeanA[x]! < medianA * 0.85;
      const ndGap = colNodata[x]! >= Math.max(0.14, medianNd + 0.03);
      if (ndGap || darkStrip) gapCol[x] = 1;
    }
    // Dilate gap marks 4px so narrow barcodes are fully covered
    {
      const copy = gapCol.slice();
      for (let x = 0; x < w; x++) {
        if (!copy[x]) continue;
        for (let k = Math.max(0, x - 4); k <= Math.min(w - 1, x + 4); k++) gapCol[k] = 1;
      }
    }

    const gapW = new Float32Array(w);
    const FEATHER = 14;
    for (let x = 0; x < w; x++) {
      if (!gapCol[x]) continue;
      for (let k = Math.max(0, x - FEATHER); k <= Math.min(w - 1, x + FEATHER); k++) {
        const dist = Math.abs(k - x) / FEATHER;
        gapW[k] = Math.max(gapW[k]!, 1 - dist);
      }
    }

    let wispData: Uint8ClampedArray | null = null;
    for (const src of [CLOUD_TEX_FALLBACK, CLOUD_TEX]) {
      try {
        const wispRes = await fetch(src, { mode: "cors" });
        if (!wispRes.ok) continue;
        await yieldFrame();
        const wispBmp = await createImageBitmap(await wispRes.blob());
        const wc = document.createElement("canvas");
        wc.width = w;
        wc.height = h;
        const wctx = wc.getContext("2d", { willReadFrequently: true })!;
        wctx.drawImage(wispBmp, 0, 0, w, h);
        wispBmp.close();
        wispData = wctx.getImageData(0, 0, w, h).data;
        break;
      } catch {
        /* next */
      }
    }
    await yieldFrame();

    function wispAlphaAt(i: number): number {
      if (!wispData) return 140;
      const wl =
        0.299 * wispData[i]! + 0.587 * wispData[i + 1]! + 0.114 * wispData[i + 2]!;
      // Bias wisps toward white (lift floor)
      return Math.round(Math.min(255, (wl / 255) * 200 + 40));
    }

    // Snapshot alphas for neighbor bleed (pre-fill)
    const liveSnap = new Uint8Array(w * h);
    for (let p = 0; p < liveSnap.length; p++) liveSnap[p] = d[(p << 2) + 3]!;

    for (let y0 = 0; y0 < h; y0 += ROW_CHUNK) {
      const y1 = Math.min(h, y0 + ROW_CHUNK);
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const p = row + x;
          const i = p << 2;
          const gw = gapW[x]!;
          const live = liveSnap[p]!;

          if (!gapCol[x] && !isNodata[p] && gw < 0.08) continue;

          // Narrow neighbor cloud bleed (white alpha only — never ocean RGB)
          let bleed = 0;
          const span = 10;
          let xl = x - 1;
          while (xl >= 0 && xl >= x - span && (gapCol[xl] || liveSnap[row + xl]! < 30)) xl--;
          let xr = x + 1;
          while (xr < w && xr <= x + span && (gapCol[xr] || liveSnap[row + xr]! < 30)) xr++;
          if (xl >= 0 && xr < w && xl >= x - span && xr <= x + span) {
            const t = (x - xl) / Math.max(1, xr - xl);
            bleed = (1 - t) * liveSnap[row + xl]! + t * liveSnap[row + xr]!;
          } else if (xl >= 0 && xl >= x - span) {
            bleed = liveSnap[row + xl]! * 0.75;
          } else if (xr < w && xr <= x + span) {
            bleed = liveSnap[row + xr]! * 0.75;
          }

          const wa = wispAlphaAt(i);
          if (isNodata[p] || gapCol[x]) {
            // Wisp-dominated fill (not flat gray floor); light bleed only
            const fill = Math.round(wa * 0.82 + bleed * 0.22);
            const out = Math.max(live, fill);
            d[i] = d[i + 1] = d[i + 2] = 255;
            d[i + 3] = Math.min(190, out);
            continue;
          }

          // Soft edge into gap zone
          if (gw > 0.08 && live > 0) {
            const mix = gw * 0.4;
            d[i + 3] = Math.round(live * (1 - mix * 0.25) + wa * mix * 0.45);
          }
        }
      }
      await yieldFrame();
    }

    // Soften barcode fill edges only (3px horiz, gap columns) — not ocean smear
    {
      const tmp = new Uint8Array(w * h);
      for (let p = 0; p < tmp.length; p++) tmp[p] = d[(p << 2) + 3]!;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          if (gapW[x]! < 0.2) continue;
          let sum = 0;
          let n = 0;
          for (let k = Math.max(0, x - 3); k <= Math.min(w - 1, x + 3); k++) {
            sum += tmp[row + k]!;
            n++;
          }
          const i = (row + x) << 2;
          const blended = sum / n;
          const m = Math.min(1, gapW[x]!);
          d[i + 3] = Math.round(tmp[row + x]! * (1 - m * 0.65) + blended * (m * 0.65));
        }
      }
    }

    ctx.putImageData(id, 0, 0);
    await yieldFrame();

    const soft = document.createElement("canvas");
    soft.width = w;
    soft.height = h;
    const sctx = soft.getContext("2d")!;
    sctx.filter = "blur(1.1px)";
    sctx.drawImage(c, 0, 0);

    const tex = new THREE.CanvasTexture(soft);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    (tex as THREE.Texture & { userData: Record<string, string> }).userData = {
      liveCloudsBuild: LIVE_CLOUDS_BUILD,
    };
    return tex;
  }

  async function setCloudSource(source: CloudSource): Promise<{ ok: boolean; error?: string }> {
    if (source.mode === "animated") {
      liveLoadToken += 1;
      cloudMode = "animated";
      cloudDrift = cloudDriftBase;
      cloudDrift2 = cloudDrift2Base;
      clouds.rotation.y = animatedCloudRotY;
      clouds.rotation.z = animatedCloudRotZ;
      cloudShadow.rotation.copy(clouds.rotation);
      if (animatedCloudTex) bindCloudTex(animatedCloudTex, THREE.RepeatWrapping);
      applyCloudAmount(opts.getCloudAmount());
      return { ok: true };
    }

    const token = ++liveLoadToken;
    try {
      const tex = await trueColorToCloudMask(source.url);
      if (token !== liveLoadToken) {
        tex.dispose();
        return { ok: false, error: "stale" };
      }
      if (liveCloudTex) liveCloudTex.dispose();
      liveCloudTex = tex;
      cloudMode = "live";
      cloudDrift = 0;
      // Keep visible wispy drift so gap fill doesn't look frozen/static
      cloudDrift2 = cloudDrift2Base * 0.85;
      // Align equirectangular mosaic with Blue Marble (no decorative drift offset)
      clouds.rotation.y = 0;
      clouds.rotation.z = 0;
      cloudShadow.rotation.set(0, 0, 0);
      bindCloudTex(tex, THREE.ClampToEdgeWrapping);
      applyCloudAmount(opts.getCloudAmount());
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
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

  // Second wispy cloud layer for depth (animated mode only)
  const cloudMat2 = cloudMat.clone();
  cloudMat2.opacity = 0.35;
  const clouds2 = new THREE.Mesh(new THREE.SphereGeometry(1.022, 64, 64), cloudMat2);
  clouds2.rotation.y = Math.random() * Math.PI * 2;
  earthGroup.add(clouds2);
  function bindClouds2(tex: THREE.Texture) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    cloudMat2.map = tex;
    cloudMat2.alphaMap = tex;
    cloudMat2.color.set(0xffffff);
    cloudMat2.emissive.set(0xffffff);
    cloudMat2.emissiveIntensity = 0.35;
    cloudMat2.needsUpdate = true;
  }
  loader.load(CLOUD_TEX, bindClouds2, undefined, () => {
    loader.load(CLOUD_TEX_FALLBACK, bindClouds2);
  });

  // Fresnel atmosphere (subtle)
  const atmosUniforms = {
    uGlowColor: { value: new THREE.Color(0x1e3a5f) },
    uRimColor: { value: new THREE.Color(0x7dd3fc) },
    uIntensity: { value: 0.62 },
    uPower: { value: 2.8 },
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
        gl_FragColor = vec4(col, fresnel * 0.55);
      }
    `,
  });
  earthGroup.add(new THREE.Mesh(new THREE.SphereGeometry(1.045, 64, 64), atmosMat));

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
        gl_FragColor = vec4(uColor, fresnel * (0.18 + uPulse * 0.45));
      }
    `,
  });
  earthGroup.add(new THREE.Mesh(new THREE.SphereGeometry(1.055, 48, 48), hazeMat));

  // Visitor markers — bright core + expanding ripple rings (not spheres)
  const markerGroup = new THREE.Group();
  earthGroup.add(markerGroup);
  const visitorDotTex = makeDotTexture();
  const visitorRingTex = makeRingTexture();

  type VisitorMarkerFx = {
    group: THREE.Group;
    core: THREE.Sprite;
    ringA: THREE.Sprite;
    ringB: THREE.Sprite;
    phase: number;
    self: boolean;
  };
  const markerPool: VisitorMarkerFx[] = [];

  function makeVisitorMarker(self: boolean): VisitorMarkerFx {
    const group = new THREE.Group();
    group.frustumCulled = false;
    const coreColor = self ? 0xfff7ed : 0xfbbf24;
    const ringColor = self ? 0xfbbf24 : 0xf59e0b;
    const core = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: visitorDotTex,
        color: coreColor,
        transparent: true,
        opacity: 0.95,
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    core.scale.setScalar(0.026);
    core.renderOrder = 14;
    core.frustumCulled = false;
    const ringA = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: visitorRingTex,
        color: ringColor,
        transparent: true,
        opacity: 0.55,
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ringA.scale.setScalar(0.03);
    ringA.renderOrder = 13;
    ringA.frustumCulled = false;
    const ringB = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: visitorRingTex,
        color: ringColor,
        transparent: true,
        opacity: 0.4,
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ringB.scale.setScalar(0.03);
    ringB.renderOrder = 12;
    ringB.frustumCulled = false;
    group.add(core, ringA, ringB);
    markerGroup.add(group);
    // Stable phase from pool index later; temporary random
    return { group, core, ringA, ringB, phase: Math.random() * Math.PI * 2, self };
  }

  function hashJitter(id: string): { dLat: number; dLng: number; dAlt: number; phase: number } {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    const a = ((h >>> 0) % 1000) / 1000;
    const b = (((h >>> 10) % 1000) / 1000);
    const c = (((h >>> 20) % 1000) / 1000);
    return {
      dLat: (a - 0.5) * 0.7,
      dLng: (b - 0.5) * 0.7,
      dAlt: 14 + ((h >>> 20) % 10),
      phase: c * Math.PI * 2,
    };
  }

  const markerCamLocal = new THREE.Vector3();
  const markerInvRoot = new THREE.Matrix4();

  function syncMarkers(list: LatLngMarker[], timeMs: number) {
    while (markerPool.length < list.length) {
      markerPool.push(makeVisitorMarker(false));
    }
    // Markers live under earthGroup→root; compare local pos to camera in root space
    markerInvRoot.copy(root.matrixWorld).invert();
    markerCamLocal.copy(camera.position).applyMatrix4(markerInvRoot);

    for (let i = 0; i < markerPool.length; i++) {
      const fx = markerPool[i]!;
      const data = list[i];
      if (!data) {
        fx.group.visible = false;
        continue;
      }
      fx.group.visible = true;
      if (fx.self !== !!data.self) {
        fx.self = !!data.self;
        const coreColor = fx.self ? 0xfff7ed : 0xfbbf24;
        const ringColor = fx.self ? 0xfbbf24 : 0xf59e0b;
        (fx.core.material as THREE.SpriteMaterial).color.setHex(coreColor);
        (fx.ringA.material as THREE.SpriteMaterial).color.setHex(ringColor);
        (fx.ringB.material as THREE.SpriteMaterial).color.setHex(ringColor);
      }
      const j = hashJitter(data.id);
      fx.phase = j.phase;
      latLngAltToVec3(data.lat + j.dLat, data.lng + j.dLng, j.dAlt, fx.group.position);

      const bright = farSideBrightness(fx.group.position, markerCamLocal);
      const coreSize = Math.max(0.018, Math.min(0.032, data.size * 0.22));
      fx.core.scale.setScalar(coreSize);

      // Two staggered ripples; max radius kept modest (~0.07) so they don't dominate
      const tA = ((timeMs * 0.0007 + fx.phase) % 1 + 1) % 1;
      const tB = ((timeMs * 0.0007 + fx.phase + 0.5) % 1 + 1) % 1;
      const rMin = coreSize * 1.15;
      const rMax = Math.min(0.095, coreSize * 4.2);
      fx.ringA.scale.setScalar(rMin + (rMax - rMin) * tA);
      fx.ringB.scale.setScalar(rMin + (rMax - rMin) * tB);
      (fx.core.material as THREE.SpriteMaterial).opacity = (fx.self ? 0.98 : 0.88) * Math.max(0.15, bright);
      (fx.ringA.material as THREE.SpriteMaterial).opacity = (1 - tA) * (1 - tA) * 0.75 * Math.max(0.12, bright);
      (fx.ringB.material as THREE.SpriteMaterial).opacity = (1 - tB) * (1 - tB) * 0.55 * Math.max(0.12, bright);
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
    depthTest: true,
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
    depthTest: true,
    depthWrite: false,
  });
  const orbitGlow = new THREE.LineLoop(orbitGlowGeo, orbitGlowMat);
  orbitGlow.renderOrder = 9;
  orbitGlow.frustumCulled = false;
  earthGroup.add(orbitGlow);

  const iss = createIssModel();
  // ~1.8× prior so model reads at default zoom (Alan/Aura R2)
  iss.scale.setScalar(0.078);
  iss.renderOrder = 20;
  iss.frustumCulled = false;
  iss.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.material) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        const m = mat as THREE.MeshStandardMaterial;
        m.depthTest = true; // real Earth occlusion (Aura R1 P0)
        m.depthWrite = false;
        m.transparent = true;
        if ("emissiveIntensity" in m) {
          m.emissiveIntensity = Math.min(0.45, (m.emissiveIntensity || 0) + 0.12);
          m.userData.baseEmissive = m.emissiveIntensity;
        }
        m.userData.baseOpacity = m.opacity ?? 1;
      }
      mesh.renderOrder = 20;
    }
  });
  earthGroup.add(iss);

  const issGlowTex = makeGlowSprite();
  // Amber core + cyan halo so ISS pops against Earth/orbit
  const issGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: issGlowTex,
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.7,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  issGlow.scale.setScalar(0.18);
  issGlow.renderOrder = 19;
  issGlow.frustumCulled = false;
  earthGroup.add(issGlow);

  const issCyanGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: issGlowTex,
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.55,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  issCyanGlow.scale.setScalar(0.28);
  issCyanGlow.renderOrder = 18;
  issCyanGlow.frustumCulled = false;
  earthGroup.add(issCyanGlow);

  const ISS_GLOW_OPACITY = 0.7;
  const ISS_CYAN_OPACITY = 0.55;
  (issGlow.material as THREE.SpriteMaterial).opacity = ISS_GLOW_OPACITY;
  (issCyanGlow.material as THREE.SpriteMaterial).opacity = ISS_CYAN_OPACITY;

  // --- Starlink constellation as Points (chunked SGP4, no heavy meshes) ---
  const STARLINK_CHUNK = 320;
  const STARLINK_REFRESH_MS = 15_000;
  const STARLINK_ALT_FALLBACK_KM = 550;
  const STARLINK_HARD_MAX = 8000;
  const STARLINK_DEFAULT_DENSITY = 2200;
  const STARLINK_DEFAULT_BRIGHTNESS = 0.42;
  let starlinkCatalog: StarlinkTlePair[] = [];
  let starlinkSatrecs: satellite.SatRec[] = [];
  let starlinkPropCursor = 0;
  let starlinkPropActive = false;
  let starlinkLastFull = 0;
  let starlinkCount = 0;
  let starlinkAppliedDensity = -1;
  const starlinkPositions = new Float32Array(3); // replaced on catalog load
  let starlinkPosAttr = new THREE.BufferAttribute(starlinkPositions, 3);
  const starlinkGeo = new THREE.BufferGeometry();
  starlinkGeo.setAttribute("position", starlinkPosAttr);
  const starlinkMat = new THREE.PointsMaterial({
    color: 0xa5b4fc,
    size: 0.0055,
    transparent: true,
    opacity: STARLINK_DEFAULT_BRIGHTNESS,
    depthTest: true,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const starlinkPoints = new THREE.Points(starlinkGeo, starlinkMat);
  starlinkPoints.frustumCulled = false;
  starlinkPoints.renderOrder = 8;
  starlinkPoints.visible = false;
  earthGroup.add(starlinkPoints);

  function rebuildStarlinkSatrecs(densityTarget: number) {
    const max = Math.min(
      STARLINK_HARD_MAX,
      Math.max(500, Math.floor(densityTarget) || STARLINK_DEFAULT_DENSITY),
    );
    if (!starlinkCatalog.length) {
      starlinkSatrecs = [];
      starlinkCount = 0;
      starlinkAppliedDensity = max;
      starlinkPoints.visible = false;
      starlinkGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
      return;
    }
    const step = Math.max(1, Math.ceil(starlinkCatalog.length / max));
    const recs: satellite.SatRec[] = [];
    for (let i = 0; i < starlinkCatalog.length; i += step) {
      const pair = starlinkCatalog[i]!;
      try {
        const rec = satellite.twoline2satrec(pair[0], pair[1]);
        if (rec) recs.push(rec);
      } catch {
        /* skip */
      }
      if (recs.length >= max) break;
    }
    starlinkSatrecs = recs;
    starlinkCount = recs.length;
    starlinkAppliedDensity = max;
    const buf = new Float32Array(Math.max(1, recs.length) * 3);
    starlinkPosAttr = new THREE.BufferAttribute(buf, 3);
    starlinkPosAttr.setUsage(THREE.DynamicDrawUsage);
    starlinkGeo.setAttribute("position", starlinkPosAttr);
    starlinkGeo.setDrawRange(0, recs.length);
    starlinkPropCursor = 0;
    starlinkPropActive = true;
    starlinkLastFull = 0;
  }

  function setStarlinkTles(tles: StarlinkTlePair[] | null) {
    starlinkCatalog = tles && tles.length ? tles.slice(0, STARLINK_HARD_MAX) : [];
    const density = opts.getStarlinkDensity?.() ?? STARLINK_DEFAULT_DENSITY;
    rebuildStarlinkSatrecs(density);
  }

  function applyStarlinkVisuals() {
    const bright = Math.min(1, Math.max(0.05, opts.getStarlinkBrightness?.() ?? STARLINK_DEFAULT_BRIGHTNESS));
    starlinkMat.opacity = bright;
    // Slight size couple so brighter also reads a bit larger, still modest
    starlinkMat.size = 0.0035 + bright * 0.005;
    const density = opts.getStarlinkDensity?.() ?? STARLINK_DEFAULT_DENSITY;
    if (Math.abs(density - starlinkAppliedDensity) >= 50 && starlinkCatalog.length) {
      rebuildStarlinkSatrecs(density);
    }
  }

  function tickStarlink(now: Date, time: number, show: boolean) {
    if (!show || starlinkCount === 0) {
      starlinkPoints.visible = false;
      return;
    }
    starlinkPoints.visible = true;
    if (!starlinkPropActive && (time - starlinkLastFull > STARLINK_REFRESH_MS || starlinkLastFull === 0)) {
      starlinkPropActive = true;
      starlinkPropCursor = 0;
    }
    if (!starlinkPropActive) return;
    const arr = starlinkPosAttr.array as Float32Array;
    const end = Math.min(starlinkPropCursor + STARLINK_CHUNK, starlinkCount);
    for (let i = starlinkPropCursor; i < end; i++) {
      const rec = starlinkSatrecs[i]!;
      const pv = satellite.propagate(rec, now);
      let lat = 0;
      let lng = 0;
      let alt = STARLINK_ALT_FALLBACK_KM;
      if (pv && pv.position && typeof pv.position !== "boolean") {
        const gmst = satellite.gstime(now);
        const gd = satellite.eciToGeodetic(pv.position as satellite.EciVec3<number>, gmst);
        lat = satellite.degreesLat(gd.latitude);
        lng = satellite.degreesLong(gd.longitude);
        alt = (gd.height || 0) > 50 ? gd.height : STARLINK_ALT_FALLBACK_KM;
      }
      latLngAltToVec3(lat, lng, alt, tmp);
      const o = i * 3;
      arr[o] = tmp.x;
      arr[o + 1] = tmp.y;
      arr[o + 2] = tmp.z;
    }
    starlinkPropCursor = end;
    if (starlinkPropCursor >= starlinkCount) {
      starlinkPosAttr.needsUpdate = true;
      starlinkPropActive = false;
      starlinkLastFull = time;
    }
  }

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

  // Astronomical sun in world/ECEF-mapped globe axes; Earth (root) spins under it.
  // Marker tracks the same vector so lit hemisphere stays aligned (Aura R1 P1).
  const liveSun = new THREE.Vector3(0.55, 0.4, 1.0).normalize();
  sunDir.copy(liveSun);
  dayNightUniforms.uSunDir.value.copy(liveSun);
  sun.position.copy(liveSun).multiplyScalar(6);
  sun.target.position.set(0, 0, 0);

  function updateSun(date: Date) {
    sunDirModel(date, liveSun);
    sunDir.copy(liveSun);
    dayNightUniforms.uSunDir.value.copy(liveSun);
    sun.position.copy(liveSun).multiplyScalar(6);
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

  // --- Sun marker (world-fixed, readable like satellitemap; Earth spins under it) ---
  function makeSunTexture(size = 96) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255, 255, 240, 1)");
    g.addColorStop(0.25, "rgba(253, 224, 71, 0.95)");
    g.addColorStop(0.55, "rgba(251, 146, 60, 0.45)");
    g.addColorStop(1, "rgba(251, 146, 60, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const sunTex = makeSunTexture();
  const sunSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: sunTex,
      color: 0xfde68a,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  sunSprite.scale.setScalar(0.22);
  sunSprite.renderOrder = 30;
  sunSprite.frustumCulled = false;
  scene.add(sunSprite); // world space — not under root
  const sunBeam = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: sunTex,
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.35,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  sunBeam.scale.setScalar(0.42);
  sunBeam.renderOrder = 29;
  sunBeam.frustumCulled = false;
  scene.add(sunBeam);

  // --- Drag vs rotate: persistent view pose (Alan R2 — no snap-back) ---
  let interactionMode: "rotate" | "drag" = "rotate";
  let dragPointerId: number | null = null;
  let dragLastX = 0;
  let dragLastY = 0;
  let dragVelY = 0;
  let dragVelX = 0;
  // Single source of truth for earth orientation — never reset on mode flicker
  let viewTheta = 0;
  let viewPhi = 0.18;
  const DRAG_PHI_MIN = -0.85;
  const DRAG_PHI_MAX = 0.95;
  const DRAG_SENS = 0.0032;
  const DRAG_INERTIA = 0.78;
  const ROTATE_PHI = 0.18;

  function applyInteractionMode(mode: "rotate" | "drag") {
    const prev = interactionMode;
    interactionMode = mode;
    // Do NOT reseeds angles from root — viewTheta/viewPhi already persist
    dragVelX = 0;
    dragVelY = 0;
    if (mode === "drag") {
      canvas.style.cursor = "grab";
    } else {
      canvas.style.cursor = "";
      // Optional: ease tilt toward default when entering auto-spin (not a hard snap of yaw)
      if (prev === "drag") {
        /* keep viewPhi; rotate mode will gently lerp toward ROTATE_PHI */
      }
    }
  }

  function onPointerDown(e: PointerEvent) {
    if ((opts.getInteractionMode?.() ?? "rotate") !== "drag") return;
    if (e.button !== 0) return;
    dragPointerId = e.pointerId;
    dragLastX = e.clientX;
    dragLastY = e.clientY;
    dragVelX = 0;
    dragVelY = 0;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    canvas.style.cursor = "grabbing";
    e.preventDefault();
  }
  function onPointerMove(e: PointerEvent) {
    if (dragPointerId !== e.pointerId) return;
    const dx = e.clientX - dragLastX;
    const dy = e.clientY - dragLastY;
    dragLastX = e.clientX;
    dragLastY = e.clientY;
    viewTheta += dx * DRAG_SENS;
    viewPhi = Math.min(DRAG_PHI_MAX, Math.max(DRAG_PHI_MIN, viewPhi + dy * DRAG_SENS));
    dragVelY = dx * DRAG_SENS;
    dragVelX = dy * DRAG_SENS;
  }
  function onPointerUp(e: PointerEvent) {
    if (dragPointerId !== e.pointerId) return;
    dragPointerId = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if ((opts.getInteractionMode?.() ?? "rotate") === "drag") canvas.style.cursor = "grab";
  }
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  // Do NOT bind pointerleave → up: it cancelled capture mid-drag and contributed to snap-back

  // Stable ISS orientation — avoid lookAt singularity when velocity ‖ radial
  const issQuat = new THREE.Quaternion();
  const issTargetQuat = new THREE.Quaternion();
  const issXAxis = new THREE.Vector3();
  const issYAxis = new THREE.Vector3();
  const issZAxis = new THREE.Vector3();
  const issMat = new THREE.Matrix4();
  let issOrientInit = false;

  function orientIss(pos: THREE.Vector3, aheadPos: THREE.Vector3) {
    // Z = velocity / forward along track; Y = radial outward (nadir-up for station);
    // X = Y × Z. If nearly parallel, fall back to world-north projection.
    issZAxis.subVectors(aheadPos, pos);
    if (issZAxis.lengthSq() < 1e-10) return;
    issZAxis.normalize();
    issYAxis.copy(pos).normalize();
    issXAxis.crossVectors(issYAxis, issZAxis);
    if (issXAxis.lengthSq() < 1e-8) {
      // Singularity: use world +Y projected
      tmp2.set(0, 1, 0);
      issXAxis.crossVectors(tmp2, issZAxis);
      if (issXAxis.lengthSq() < 1e-8) {
        tmp2.set(1, 0, 0);
        issXAxis.crossVectors(tmp2, issZAxis);
      }
    }
    issXAxis.normalize();
    issYAxis.crossVectors(issZAxis, issXAxis).normalize();
    issMat.makeBasis(issXAxis, issYAxis, issZAxis);
    issTargetQuat.setFromRotationMatrix(issMat);
    if (!issOrientInit) {
      issQuat.copy(issTargetQuat);
      issOrientInit = true;
    } else {
      // Shortest-arc slerp; damp flips
      if (issQuat.dot(issTargetQuat) < 0) {
        issTargetQuat.x *= -1;
        issTargetQuat.y *= -1;
        issTargetQuat.z *= -1;
        issTargetQuat.w *= -1;
      }
      issQuat.slerp(issTargetQuat, 0.18);
    }
    iss.quaternion.copy(issQuat);
  }

  function applyIssDim(bright: number) {
    iss.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        const m = mat as THREE.MeshStandardMaterial;
        if (typeof m.userData.baseEmissive === "number") {
          m.emissiveIntensity = m.userData.baseEmissive * bright;
        }
        if (typeof m.userData.baseOpacity === "number") {
          m.opacity = Math.max(0.22, m.userData.baseOpacity * (0.25 + 0.75 * bright));
        }
      }
    });
    (issGlow.material as THREE.SpriteMaterial).opacity = ISS_GLOW_OPACITY * bright;
    (issCyanGlow.material as THREE.SpriteMaterial).opacity = ISS_CYAN_OPACITY * bright;
  }

  function frame(time: number) {
    if (!running) return;
    raf = requestAnimationFrame(frame);

    const mode = opts.getInteractionMode?.() ?? "rotate";
    if (mode !== interactionMode) applyInteractionMode(mode);

    const showIss = opts.getShowIss?.() ?? true;
    const showStarlink = opts.getShowStarlink?.() ?? false;
    if (showStarlink) applyStarlinkVisuals();

    const now = new Date();
    updateSun(now);
    // Sun glyph sits just outside Earth limb along fixed sun direction
    sunSprite.position.copy(liveSun).multiplyScalar(1.28);
    sunBeam.position.copy(liveSun).multiplyScalar(1.22);
    const sunPulse = 0.5 + 0.5 * Math.sin(time * 0.002);
    sunSprite.scale.setScalar(0.2 + 0.04 * sunPulse);
    sunBeam.scale.setScalar(0.38 + 0.06 * sunPulse);

    // Orbit rebuild whenever TLE is available
    if (showIss && ensureSatrec() && (time - lastOrbitBuild > 20_000 || lastOrbitBuild === 0)) {
      try {
        rebuildOrbit(now);
        lastOrbitBuild = time;
      } catch (err) {
        console.warn("rebuildOrbit failed", err);
      }
    }

    const p = showIss ? propagate(now) : null;
    if (p) {
      latLngAltToVec3(p.latitude, p.longitude, p.altitude, iss.position);
      issGlow.position.copy(iss.position);
      issCyanGlow.position.copy(iss.position);

      const ahead = propagate(new Date(now.getTime() + 20_000));
      if (ahead) {
        latLngAltToVec3(ahead.latitude, ahead.longitude, ahead.altitude, tmp);
        orientIss(iss.position, tmp);
      }

      // Real depth occlusion (depthTest) + soft limb fade; hide when fully behind
      root.updateMatrixWorld(true);
      iss.getWorldPosition(tmp2);
      const issBright = farSideBrightness(tmp2, camera.position);
      applyIssDim(Math.max(0.35, issBright));
      const occluded = issBright < 0.02;
      iss.visible = !occluded;
      issGlow.visible = !occluded && issBright > 0.08;
      issCyanGlow.visible = !occluded && issBright > 0.08;

      const issPulse = 0.5 + 0.5 * Math.sin(time * 0.004);
      issGlow.scale.setScalar((0.16 + 0.04 * issPulse) * (0.55 + 0.45 * issBright));
      issCyanGlow.scale.setScalar((0.24 + 0.06 * issPulse) * (0.55 + 0.45 * issBright));

      if (time - lastIssEmit > 1000) {
        lastIssEmit = time;
        opts.onIssUpdate?.({
          latitude: p.latitude,
          longitude: p.longitude,
          altitude: p.altitude,
          velocity: p.velocity,
        });
      }
      orbitLine.visible = orbitReady;
      orbitGlow.visible = orbitReady;
    } else {
      if (!orbitReady || !showIss) {
        iss.visible = false;
        issGlow.visible = false;
        issCyanGlow.visible = false;
      }
      orbitLine.visible = showIss && orbitReady;
      orbitGlow.visible = showIss && orbitReady;
      if (!showIss) {
        iss.visible = false;
        issGlow.visible = false;
        issCyanGlow.visible = false;
      }
      if (showIss && time - lastIssEmit > 2000) {
        lastIssEmit = time;
        opts.onIssUpdate?.(null);
      }
    }

    tickStarlink(now, time, showStarlink);

    applyCloudAmount(opts.getCloudAmount());
    clouds.rotation.y += cloudDrift;
    clouds2.rotation.y += cloudDrift2;
    cloudShadow.rotation.y = clouds.rotation.y;
    cloudShadow.rotation.z = clouds.rotation.z;

    if (interactionMode === "drag") {
      if (dragPointerId == null) {
        viewTheta += dragVelY;
        viewPhi = Math.min(DRAG_PHI_MAX, Math.max(DRAG_PHI_MIN, viewPhi + dragVelX));
        dragVelY *= DRAG_INERTIA;
        dragVelX *= DRAG_INERTIA;
        if (Math.abs(dragVelY) < 1e-5) dragVelY = 0;
        if (Math.abs(dragVelX) < 1e-5) dragVelX = 0;
      }
    } else {
      viewTheta += opts.getRotationSpeed();
      // Softly ease tilt toward default — never hard-reset yaw (Alan R2 snap-back fix)
      viewPhi += (ROTATE_PHI - viewPhi) * 0.04;
    }
    root.rotation.y = viewTheta;
    root.rotation.x = viewPhi;
    phi = viewTheta;

    root.updateMatrixWorld(true);
    syncMarkers(opts.getMarkers(), time);

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
      liveLoadToken += 1;
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      ro?.disconnect();
      orbitGeo.dispose();
      orbitGlowGeo.dispose();
      earthGeo.dispose();
      earthMat.dispose();
      for (const fx of markerPool) {
        (fx.core.material as THREE.SpriteMaterial).dispose();
        (fx.ringA.material as THREE.SpriteMaterial).dispose();
        (fx.ringB.material as THREE.SpriteMaterial).dispose();
      }
      visitorDotTex.dispose();
      visitorRingTex.dispose();
      issGlowTex.dispose();
      sunTex.dispose();
      (sunSprite.material as THREE.SpriteMaterial).dispose();
      (sunBeam.material as THREE.SpriteMaterial).dispose();
      starlinkGeo.dispose();
      starlinkMat.dispose();
      liveCloudTex?.dispose();
      cloudMat.dispose();
      cloudMat2.dispose();
      cloudShadowMat.dispose();
      renderer.dispose();
    },
    resize,
    setCloudSource,
    setStarlinkTles,
    getStarlinkDrawn: () => starlinkCount,
  };
}
