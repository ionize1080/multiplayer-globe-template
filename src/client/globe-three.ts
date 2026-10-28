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
};

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

  // Visitor markers
  const markerGroup = new THREE.Group();
  earthGroup.add(markerGroup);
  const markerGeo = new THREE.SphereGeometry(1, 12, 12);
  const markerMatSelf = new THREE.MeshStandardMaterial({
    color: 0xfff7ed,
    emissive: 0xfbbf24,
    emissiveIntensity: 0.85,
    roughness: 0.4,
    metalness: 0.15,
    depthTest: false,
    depthWrite: false,
  });
  const markerMatOther = new THREE.MeshStandardMaterial({
    color: 0xfed7aa,
    emissive: 0xf59e0b,
    emissiveIntensity: 0.55,
    roughness: 0.45,
    metalness: 0.1,
    depthTest: false,
    depthWrite: false,
  });
  const markerPool: THREE.Mesh[] = [];

  function hashJitter(id: string): { dLat: number; dLng: number; dAlt: number } {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    const a = ((h >>> 0) % 1000) / 1000;
    const b = (((h >>> 10) % 1000) / 1000);
    // Spread coincident visitors (~±0.35°) so stacked same-city dots separate
    return {
      dLat: (a - 0.5) * 0.7,
      dLng: (b - 0.5) * 0.7,
      dAlt: 14 + ((h >>> 20) % 10),
    };
  }

  function syncMarkers(list: LatLngMarker[]) {
    while (markerPool.length < list.length) {
      const m = new THREE.Mesh(markerGeo, markerMatOther);
      m.renderOrder = 12;
      m.frustumCulled = false;
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
      (mesh.material as THREE.MeshStandardMaterial).depthTest = false;
      (mesh.material as THREE.MeshStandardMaterial).depthWrite = false;
      mesh.scale.setScalar(Math.max(0.014, Math.min(0.036, data.size * 0.28)));
      const j = hashJitter(data.id);
      latLngAltToVec3(data.lat + j.dLat, data.lng + j.dLng, j.dAlt, mesh.position);
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
        m.depthTest = false;
        m.depthWrite = false;
        if ("emissiveIntensity" in m) m.emissiveIntensity = Math.min(0.45, (m.emissiveIntensity || 0) + 0.12);
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
      depthTest: false,
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
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  issCyanGlow.scale.setScalar(0.28);
  issCyanGlow.renderOrder = 18;
  issCyanGlow.frustumCulled = false;
  earthGroup.add(issCyanGlow);

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

  // World-fixed sun: set once toward the default camera-facing hemisphere (~half lit).
  // Does NOT track the camera each frame — Earth rotates under a stable light (Jack: 太阳位置固定).
  const FIXED_SUN = new THREE.Vector3(0.55, 0.4, 1.0).normalize();
  sunDir.copy(FIXED_SUN);
  dayNightUniforms.uSunDir.value.copy(FIXED_SUN);
  sun.position.copy(FIXED_SUN).multiplyScalar(6);
  sun.target.position.set(0, 0, 0);

  function updateSun(_date: Date) {
    // Keep sun fixed in world space while Earth (root) spins.
    sunDir.copy(FIXED_SUN);
    dayNightUniforms.uSunDir.value.copy(FIXED_SUN);
    sun.position.copy(FIXED_SUN).multiplyScalar(6);
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
      issCyanGlow.position.copy(iss.position);

      const ahead = propagate(new Date(now.getTime() + 20_000));
      if (ahead) {
        latLngAltToVec3(ahead.latitude, ahead.longitude, ahead.altitude, tmp);
        iss.up.copy(iss.position).normalize();
        iss.lookAt(tmp);
        iss.rotateX(Math.PI / 2);
      }

      const issPulse = 0.5 + 0.5 * Math.sin(time * 0.004);
      issGlow.scale.setScalar(0.16 + 0.04 * issPulse);
      issCyanGlow.scale.setScalar(0.24 + 0.06 * issPulse);

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
      issCyanGlow.visible = true;
    } else {
      // Keep ISS visible at last position if orbit already built (transient prop miss);
      // only hide when we never had a TLE orbit.
      if (!orbitReady) {
        iss.visible = false;
        issGlow.visible = false;
        issCyanGlow.visible = false;
      }
      if (time - lastIssEmit > 2000) {
        lastIssEmit = time;
        // Don't clear panel permanently — parent retries TLE; keep last snapshot if any
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
      liveLoadToken += 1;
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
      liveCloudTex?.dispose();
      cloudMat.dispose();
      cloudMat2.dispose();
      cloudShadowMat.dispose();
      renderer.dispose();
    },
    resize,
    setCloudSource,
  };
}
