import * as THREE from "three";
import * as satellite from "satellite.js";
import { normalizeCloudRows } from "./cloud-mask";
import { sampleOrbit } from "./orbit-sampler";
import { OrbitInterpolator } from "./orbit-interpolation";
import { createIssModel } from "./iss-model";
import { photoSunDirection, type SunLighting } from "./sun-lighting";

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
  | { mode: "live"; url: string; revision: string };

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
  /** Day-hemisphere shader gain (uDayBoost); default 1.35 */
  getDayBrightness?: () => number;
  getSunLighting?: () => SunLighting;
  /** "rotate" = auto-spin; "drag" = pointer orbit (mutually exclusive) */
  getInteractionMode?: () => "rotate" | "drag";
};

export type StarlinkTlePair = [string, string];

/** Survives React remounts / StrictMode — Alan fx5 ~10s snap-back */
export type GlobeViewPose = { theta: number; phi: number; camYaw?: number; framed?: boolean };
const VIEW_POSE_KEY = "ionize-view-pose-fx21"; // Preserve the production camera pose.
const VIEW_PHI_DEFAULT = 0.18;
/** Camera orbit distance (Aura R3); yaw frames sun on right limb without faking sunDir */
const CAM_DIST = 3.05;

function clampPhi(phi: number) {
  return Math.min(0.95, Math.max(-0.85, phi));
}

function readStoredViewPose(): GlobeViewPose {
  try {
    const raw = sessionStorage.getItem(VIEW_POSE_KEY);
    if (!raw) return { theta: 0, phi: VIEW_PHI_DEFAULT };
    const p = JSON.parse(raw) as Partial<GlobeViewPose>;
    const pose: GlobeViewPose = {
      theta: Number.isFinite(p.theta) ? (p.theta as number) : 0,
      phi: Number.isFinite(p.phi) ? clampPhi(p.phi as number) : VIEW_PHI_DEFAULT,
    };
    if (Number.isFinite(p.camYaw)) pose.camYaw = p.camYaw as number;
    if (p.framed === true) pose.framed = true;
    // fx16: yaw=0 may be valid — only drop framed if camYaw missing/non-finite
    if (
      pose.framed === true &&
      (pose.camYaw === undefined || !Number.isFinite(pose.camYaw as number))
    ) {
      delete pose.camYaw;
      delete pose.framed;
      try {
        sessionStorage.setItem(VIEW_POSE_KEY, JSON.stringify(pose));
      } catch {
        /* private mode */
      }
    }
    return pose;
  } catch {
    return { theta: 0, phi: VIEW_PHI_DEFAULT };
  }
}

function hasStoredViewPose(): boolean {
  try {
    return sessionStorage.getItem(VIEW_POSE_KEY) != null;
  } catch {
    return false;
  }
}

let memViewPose: GlobeViewPose = readStoredViewPose();
/** Only the newest createGlobeThree instance may write pose (Alan E3 remount race). */
let activeGlobeId = 0;
let nextGlobeId = 1;
/** Tear down a prior live globe before a remount creates another (dual-RAF → E3 snap). */
let activeGlobeDispose: (() => void) | null = null;

export function getMemViewPose(): GlobeViewPose {
  return { ...memViewPose };
}

function persistViewPose(
  theta: number,
  phi: number,
  camYaw: number | undefined,
  globeId: number,
) {
  if (globeId !== activeGlobeId) return;
  // fx16: yaw=0 is a valid half-lit solve — persist any finite camYaw
  const yawOk = camYaw !== undefined && Number.isFinite(camYaw);
  const nextYaw = yawOk ? camYaw : memViewPose.camYaw;
  const nextFramed = yawOk
    ? true
    : memViewPose.framed === true && typeof memViewPose.camYaw === "number";
  memViewPose = {
    theta,
    phi,
    ...(typeof nextYaw === "number" && Number.isFinite(nextYaw)
      ? { camYaw: nextYaw }
      : {}),
    ...(nextFramed ? { framed: true as const } : {}),
  };
  try {
    sessionStorage.setItem(VIEW_POSE_KEY, JSON.stringify(memViewPose));
  } catch {
    /* private mode */
  }
}

const EARTH_RADIUS_KM = 6371;
/** Dense samples for closed inertial orbit ellipse (same GMST → true closed ring) */
const ORBIT_SAMPLES = 256;
const TEX = "https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img";
const CLOUD_TEX =
  "https://cdn.jsdelivr.net/gh/turban/webgl-earth@master/images/fair_clouds_4k.png";
const CLOUD_TEX_FALLBACK =
  "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/earth_clouds_1024.png";
/** Cache-bust / Aura verify marker — must appear in deployed /dist/index.js */
export const LIVE_CLOUDS_BUILD = "c8-20261028-satellite-alpha";
/** ISS far-side dim + visitor ripple markers */
export const GLOBE_FX_BUILD = "fx25-20261028-smooth-clouds";

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

/** Subsolar longitude (rad, -π..π) from globe-axis sun vector (x=lon0, z=-lon90). */
function sunLongitudeRad(sun: THREE.Vector3): number {
  return Math.atan2(-sun.z, sun.x);
}

/**
 * viewTheta so geographic longitude `lon` (rad) sits at disk center for camYaw.
 * At yaw=0, lon=-π/2 (Americas) → theta=0 — the old hardcoded default.
 */
function thetaForCenterLon(lon: number, camYaw: number): number {
  return Math.atan2(-Math.cos(camYaw), Math.sin(camYaw)) - lon;
}

/**
 * fx18: default / 自转 reset — sunward continents in the day half.
 * fx17 centered the western terminator (sub − π/2). When the sun is over
 * Africa that meridian is ~Americas, so seed ≈ theta=0 and day land sits on
 * the right limb (reads as night crescent). Bias ~60° toward the subsolar
 * point so day land/ocean fills center-right; terminator stays left-of-center.
 */
function thetaForHalfLitDay(sun: THREE.Vector3, camYaw: number): number {
  // fx20: put subsolar longitude at disk center (matches drag-Africa half-lit look).
  return thetaForCenterLon(sunLongitudeRad(sun), camYaw);
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

export function createGlobeThree(opts: GlobeThreeOptions) {
  // Remount safety: kill previous RAF/listeners before we become active (Alan E3)
  if (activeGlobeDispose) {
    try {
      activeGlobeDispose();
    } catch (err) {
      console.warn("[ionize-globe] prior dispose failed", err);
    }
    activeGlobeDispose = null;
  }
  // Re-read session so a remount never starts from a stale in-memory snapshot
  memViewPose = readStoredViewPose();

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
  // FOV 44→52: square canvas (aspect=1) otherwise clips right-limb sun (ndc>1 at facing≈0.12)
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
  camera.position.set(0, 0, CAM_DIST);

  // Pivot: Earth rotates under a *world-fixed* sun (terminator stays real)
  const root = new THREE.Group();
  scene.add(root);

  // --- Lighting: soft night ambient + strong sun (Google Earth–like day) ---
  const ambient = new THREE.AmbientLight(0x7a90b0, 0.48);
  scene.add(ambient);
  const hemi = new THREE.HemisphereLight(0xb8d4ff, 0x0b1224, 0.22);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff4e8, 2.1);
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

  // Safe fallback: leave the source color unchanged until the water mask loads.
  let disposed = false;
  const emptyWaterMask = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  emptyWaterMask.needsUpdate = true;
  let waterMask: THREE.Texture | null = null;
  const dayNightUniforms = {
    uWaterMask: { value: emptyWaterMask as THREE.Texture },
    uNightMap: { value: null as THREE.Texture | null },
    uSunDir: { value: sunDir.clone() },
    uDayBoost: { value: 1.35 },
    uNightFloor: { value: 0.025 },
    uCityBoost: { value: 1.6 },
    uTermSoft: { value: 0.16 },
  };

  earthMat.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterMask = dayNightUniforms.uWaterMask;
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
        // Unit sphere at origin, rotation-only: world position == world normal.
        // Equivalent to normalize(mat3(modelMatrix)*objectNormal) while scale is uniform;
        // if Earth ever translates or non-uniform-scales, switch back to mat3*normal.
        vDnNormal = normalize((modelMatrix * vec4(transformed, 1.0)).xyz);
        vDnUv = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D uNightMap;
        uniform sampler2D uWaterMask;
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
        // fx12: tighter terminator so geometric half-lit reads as ~half on screen
        float dayF = smoothstep(-uTermSoft, uTermSoft, ndl);
        // Work in linear RGB. Additive floors wash dark oceans into flat gray-blue;
        // preserve the albedo and let directional light shape the hemisphere.
        vec3 albedo = diffuseColor.rgb;
        // Select actual water, not blue terrain or white polar ice. The mask is
        // data (linear), while the albedo has already been decoded from sRGB.
        float water = smoothstep(0.4, 0.9, texture2D(uWaterMask, vDnUv).r);
        float blueChroma = (albedo.b - max(albedo.r, albedo.g)) / max(albedo.b, 0.0001);
        float oceanWeight = water * smoothstep(0.05, 0.3, blueChroma);
        float oceanLuma = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
        // Restrained navy rather than electric blue: reduce chroma and blue
        // energy, retaining the texture's relative coastal/deep-water detail.
        vec3 oceanColor = mix(vec3(oceanLuma), albedo, 0.68) * vec3(0.80, 1.02, 0.86);
        albedo = mix(albedo, oceanColor, oceanWeight);
        // Slightly warm land against steel-blue seas; neutral snow stays neutral.
        float landChroma = max(albedo.r, max(albedo.g, albedo.b)) - min(albedo.r, min(albedo.g, albedo.b));
        albedo *= mix(vec3(1.0), vec3(1.035, 1.01, 0.98), (1.0 - water) * smoothstep(0.02, 0.15, landChroma));
        float sunlight = 0.38 + 0.62 * sqrt(max(ndl, 0.0));
        vec3 dayCol = albedo * uDayBoost * sunlight;
        // Restrained silver sun glint, confined to water and the lit hemisphere.
        vec3 viewDir = normalize(cameraPosition - vDnNormal);
        vec3 halfway = normalize(normalize(uSunDir) + viewDir + vec3(0.0, 0.00001, 0.0));
        float glint = pow(max(dot(normalize(vDnNormal), halfway), 0.0), 72.0);
        dayCol += vec3(0.022, 0.028, 0.032) * glint * oceanWeight * max(ndl, 0.0);
        vec3 nightTex = texture2D(uNightMap, vDnUv).rgb;
        float cityMask = smoothstep(0.015, 0.18, max(nightTex.r, max(nightTex.g, nightTex.b)));
        vec3 cities = nightTex * cityMask * uCityBoost;
        // Dim terrain retains coastlines without a uniform gray night hemisphere.
        vec3 nightCol = albedo * vec3(0.55, 0.7, 1.0) * uNightFloor + cities;
        diffuseColor.rgb = mix(nightCol, dayCol, dayF);
        `,
      )
      .replace(
        "#include <opaque_fragment>",
        `// The day/night pass already applies lighting; do not light it twice.
        outgoingLight = diffuseColor.rgb;
        #include <opaque_fragment>`,
      );
  };
  earthMat.customProgramCacheKey = () => "earth-day-night-r8-photo-light";

  const earth = new THREE.Mesh(earthGeo, earthMat);
  earthMat.depthWrite = true;
  earthMat.depthTest = true;
  earth.renderOrder = 0;
  earthGroup.add(earth);

  const loader = new THREE.TextureLoader();

  loader.load(`${TEX}/earth-water.png`, (mask) => {
    // Texture loads may finish after a remount has disposed this globe.
    if (disposed) { mask.dispose(); return; }
    mask.colorSpace = THREE.NoColorSpace;
    mask.anisotropy = 4;
    waterMask = mask;
    dayNightUniforms.uWaterMask.value = mask;
  }, undefined, () => {
    console.warn("Ocean color mask unavailable; keeping the original Earth texture.");
  });

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
    // City emission is included only on the night side in the day/night pass.
  }
  loader.load(
    NIGHT_LIGHTS,
    applyNightMap,
    undefined,
    () => loader.load(NIGHT_FALLBACK, applyNightMap),
  );
  // The water mask is used only for selective ocean grading, not PBR roughness.

  // --- Clouds: denser / more realistic + soft shadow shell ---
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.58,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    emissive: 0x000000,
    emissiveIntensity: 0,
    side: THREE.FrontSide,
  });
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.018, 96, 96), cloudMat);
  clouds.rotation.y = Math.random() * Math.PI * 2;
  clouds.rotation.z = (Math.random() - 0.5) * 0.06;
  earthGroup.add(clouds);

  // A sparse RGBA shadow mask, never an all-over multiply shell.
  const cloudShadowMat = new THREE.MeshBasicMaterial({
    color: 0x0b1220,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    blending: THREE.NormalBlending,
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
  let liveCloudKey = "";
  let liveCloudAbort: AbortController | null = null;
  let outgoingCloudTex: THREE.Texture | null = null;
  let cloudTransitionStart = 0;
  const cloudBlend = {
    uPreviousCloud: { value: null as THREE.Texture | null },
    uCloudBlend: { value: 1 },
  };
  for (const material of [cloudMat, cloudShadowMat]) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, cloudBlend);
      shader.fragmentShader = "uniform sampler2D uPreviousCloud;\nuniform float uCloudBlend;\n" + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `
        #include <map_fragment>
        #ifdef USE_MAP
          diffuseColor.a = opacity * mix(texture2D(uPreviousCloud, vMapUv).a, texture2D(map, vMapUv).a, uCloudBlend);
        #endif
      `);
    };
    material.customProgramCacheKey = () => "satellite-cloud-crossfade-v1";
  }

  function finishCloudTransition() {
    cloudBlend.uPreviousCloud.value = cloudMat.map;
    cloudBlend.uCloudBlend.value = 1;
    outgoingCloudTex?.dispose();
    outgoingCloudTex = null;
  }

  function bindCloudTex(tex: THREE.Texture, wrap: THREE.Wrapping = THREE.RepeatWrapping) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    tex.wrapS = wrap;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    cloudMat.map = tex;
    if (!outgoingCloudTex) cloudBlend.uPreviousCloud.value = tex;
    // Both sources are white RGB + coverage in A. alphaMap samples GREEN,
    // which is always 1 in the live mask; use map's actual alpha instead.
    cloudMat.alphaMap = null;
    cloudMat.needsUpdate = true;
    cloudShadowMat.map = tex;
    cloudShadowMat.alphaMap = null;
    cloudShadowMat.needsUpdate = true;
    cloudsReady = true;
  }

  function applyCloudTex(tex: THREE.Texture) {
    if (disposed) { tex.dispose(); return; }
    // Normalize grayscale/RGBA sources once so gray mask pixels cannot tint
    // the ocean. A single texture is shared by clouds and their sparse shadow.
    const img = tex.image as CanvasImageSource & { width: number; height: number };
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, c.width, c.height);
    const d = pixels.data;
    for (let i = 0; i < d.length; i += 4) {
      const density = (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255;
      d[i + 3] = Math.round(d[i + 3]! * THREE.MathUtils.smoothstep(density, 0.08, 0.9));
      d[i] = d[i + 1] = d[i + 2] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const mask = new THREE.CanvasTexture(c);
    tex.dispose();
    animatedCloudTex = mask;
    if (cloudMode === "animated") bindCloudTex(mask, THREE.RepeatWrapping);
    bindClouds2(mask);
  }

  function applyCloudAmount(amount: number) {
    const a = Math.min(1, Math.max(0, amount));
    const on = a > 0 && (cloudsReady || !!cloudMat.map);
    clouds.visible = on;
    clouds2.visible = on && cloudMode === "animated" && !!cloudMat2.map;
    cloudShadow.visible = on;
    cloudMat.opacity = a * 0.72;
    cloudMat2.opacity = a * 0.12;
    cloudShadowMat.opacity = a * 0.08;
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

  async function satelliteCloudMask(url: string, signal: AbortSignal): Promise<THREE.CanvasTexture> {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`live cloud texture → ${res.status}`);
    if (!res.headers.get("content-type")?.includes("image/png")) throw new Error("Cloud texture is not PNG");
    const blob = await res.blob();
    if (signal.aborted) throw new Error("stale");
    const bmp = await createImageBitmap(blob);
    const maxWidth = Math.min(4096, renderer.capabilities.maxTextureSize);
    const w = Math.min(bmp.width, maxWidth);
    const h = Math.round(w / 2);
    if (bmp.width !== 2 * bmp.height || bmp.width > 8192 || bmp.width < 1024) {
      bmp.close();
      throw new Error("Unexpected cloud texture dimensions");
    }
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const pixels = ctx.getImageData(0, 0, w, h);
    for (let y = 0; y < h; y += 32) {
      if (signal.aborted) throw new Error("stale");
      normalizeCloudRows(pixels.data, w, h, y, Math.min(h, y + 32));
      await yieldFrame();
    }
    ctx.putImageData(pixels, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  async function setCloudSource(source: CloudSource): Promise<{ ok: boolean; error?: string }> {
    const token = ++liveLoadToken;
    liveCloudAbort?.abort();
    liveCloudAbort = null;
    if (source.mode === "animated") {
      finishCloudTransition();
      cloudMode = "animated";
      cloudDrift = cloudDriftBase;
      cloudDrift2 = cloudDrift2Base;
      clouds.rotation.set(0, animatedCloudRotY, animatedCloudRotZ);
      cloudShadow.rotation.copy(clouds.rotation);
      if (animatedCloudTex) bindCloudTex(animatedCloudTex, THREE.RepeatWrapping);
      else {
        cloudMat.map = cloudShadowMat.map = null;
        cloudBlend.uPreviousCloud.value = null;
        cloudMat.needsUpdate = cloudShadowMat.needsUpdate = true;
        cloudsReady = false;
      }
      liveCloudTex?.dispose();
      liveCloudTex = null;
      liveCloudKey = "";
      applyCloudAmount(opts.getCloudAmount());
      return { ok: true };
    }
    const key = source.url + source.revision;
    if (key === liveCloudKey && cloudMode === "live") return { ok: true };
    const controller = new AbortController();
    liveCloudAbort = controller;
    try {
      const tex = await satelliteCloudMask(source.url, controller.signal);
      if (token !== liveLoadToken || disposed) {
        tex.dispose();
        return { ok: false, error: "stale" };
      }
      finishCloudTransition();
      outgoingCloudTex = liveCloudTex;
      liveCloudTex = tex;
      liveCloudKey = key;
      cloudMode = "live";
      cloudDrift = cloudDrift2 = 0;
      clouds.rotation.set(0, 0, 0);
      cloudShadow.rotation.set(0, 0, 0);
      bindCloudTex(tex, THREE.RepeatWrapping);
      if (outgoingCloudTex) {
        cloudBlend.uPreviousCloud.value = outgoingCloudTex;
        cloudBlend.uCloudBlend.value = 0;
        cloudTransitionStart = performance.now();
      }
      applyCloudAmount(opts.getCloudAmount());
      return { ok: true };
    } catch (e) {
      return { ok: false, error: token !== liveLoadToken || controller.signal.aborted ? "stale" : String(e) };
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
    cloudMat2.alphaMap = null;
    cloudMat2.color.set(0xffffff);
    cloudMat2.emissive.set(0x000000);
    cloudMat2.emissiveIntensity = 0;
    cloudMat2.needsUpdate = true;
  }

  // Fresnel atmosphere (subtle)
  const atmosUniforms = {
    uGlowColor: { value: new THREE.Color(0x24445e) },
    uRimColor: { value: new THREE.Color(0xb5e5ff) },
    uIntensity: { value: 0.78 },
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
        gl_FragColor = vec4(col, fresnel * 0.55);
      }
    `,
  });
  earthGroup.add(new THREE.Mesh(new THREE.SphereGeometry(1.028, 64, 64), atmosMat));

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
  const STARLINK_CHUNK = 64;
  const STARLINK_HARD_MAX = 8000;
  const STARLINK_DEFAULT_DENSITY = 2200;
  const STARLINK_DEFAULT_BRIGHTNESS = 0.42;
  let starlinkCatalog: StarlinkTlePair[] = [];
  let starlinkSatrecs: satellite.SatRec[] = [];
  let starlinkMotion: OrbitInterpolator | null = null;
  let starlinkDrawn = 0;
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
      starlinkMotion = null;
      starlinkDrawn = 0;
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
    starlinkAppliedDensity = max;
    const buf = new Float32Array(Math.max(1, recs.length) * 3);
    starlinkPosAttr = new THREE.BufferAttribute(buf, 3);
    starlinkPosAttr.setUsage(THREE.DynamicDrawUsage);
    starlinkGeo.setAttribute("position", starlinkPosAttr);
    starlinkGeo.setDrawRange(0, 0);
    starlinkDrawn = 0;
    starlinkMotion = new OrbitInterpolator(recs.length, (index, time) => sampleOrbit(starlinkSatrecs[index]!, time));
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

  function tickStarlink(now: Date, _time: number, show: boolean) {
    if (!show || !starlinkMotion) {
      starlinkPoints.visible = false;
      starlinkDrawn = 0;
      return;
    }
    const epoch = now.getTime();
    starlinkMotion.update(epoch, STARLINK_CHUNK);
    starlinkDrawn = starlinkMotion.render(epoch, starlinkPosAttr.array as Float32Array);
    starlinkGeo.setDrawRange(0, starlinkDrawn);
    starlinkPosAttr.needsUpdate = true;
    starlinkPoints.visible = starlinkDrawn > 0;
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

  // Keep astronomical and artistic directions distinct. Every visible lighting
  // layer and the sun glyph share the selected direction.
  const astronomicalSun = new THREE.Vector3();
  const liveSun = new THREE.Vector3(0.55, 0.4, 1.0).normalize();
  sunDir.copy(liveSun);
  dayNightUniforms.uSunDir.value.copy(liveSun);
  sun.position.copy(liveSun).multiplyScalar(6);
  sun.target.position.set(0, 0, 0);

  function updateSun(date: Date) {
    sunDirModel(date, astronomicalSun);
    initializeView(astronomicalSun);
    const lighting = opts.getSunLighting?.() ?? { mode: "photo", azimuth: 0 };
    if (lighting.mode === "photo") {
      photoSunDirection(lighting.azimuth, camYaw, liveSun);
    } else {
      liveSun.copy(astronomicalSun);
    }
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
      opacity: 1,
      depthTest: true, // occlude when sun is behind Earth (fx7 pierce fix)
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  sunSprite.scale.setScalar(0.32);
  sunSprite.renderOrder = 30;
  sunSprite.frustumCulled = false;
  scene.add(sunSprite); // world space — not under root
  const sunBeam = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: sunTex,
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.5,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  sunBeam.scale.setScalar(0.58);
  sunBeam.renderOrder = 29;
  sunBeam.frustumCulled = false;
  scene.add(sunBeam);

  // --- Drag vs rotate: persistent view pose (Alan R2 — no snap-back) ---
  // Sync from React immediately — defaulting to "rotate" then flipping caused false drag→rotate resets
  let interactionMode: "rotate" | "drag" = opts.getInteractionMode?.() ?? "rotate";
  let dragPointerId: number | null = null;
  let dragLastX = 0;
  let dragLastY = 0;
  let dragVelY = 0;
  let dragVelX = 0;
  // Restore pose from module/session — remount must not snap to default
  const globeId = nextGlobeId++;
  activeGlobeId = globeId;
  let viewTheta = memViewPose.theta;
  let viewPhi = memViewPose.phi;
  // Seed an initial day-side view only when no deliberate pose was saved.
  const restoredUserPose =
    hasStoredViewPose() && Math.abs(memViewPose.theta) >= 1e-3;
  let spinPoseSeeded = restoredUserPose;
  // Camera yaw orbits around Y so world-fixed sun can sit on the RIGHT limb.
  // viewTheta only spins Earth under the sun — it cannot move the glyph on screen.
  let camYaw =
    typeof memViewPose.camYaw === "number" && Number.isFinite(memViewPose.camYaw)
      ? memViewPose.camYaw
      : 0;
  let sunFramed =
    memViewPose.framed === true &&
    typeof memViewPose.camYaw === "number" &&
    Number.isFinite(memViewPose.camYaw);
  let lastPosePersist = 0;
  let viewInitialized = false;
  const camAlong = new THREE.Vector3();

  function applyCameraYaw() {
    camera.position.set(CAM_DIST * Math.sin(camYaw), 0, CAM_DIST * Math.cos(camYaw));
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
  }
  applyCameraYaw();

  function initializeView(realSun: THREE.Vector3) {
    if (viewInitialized) return;
    // Choose the original framing only once, or restore the user's saved view.
    // Moving the light must never cause the camera to chase it.
    if (!sunFramed) {
      const radius = Math.max(0.000001, Math.hypot(realSun.x, realSun.z));
      camYaw = Math.atan2(realSun.x, realSun.z) - Math.acos(THREE.MathUtils.clamp(0.32 / radius, -1, 1));
      sunFramed = true;
    }
    if (!spinPoseSeeded && interactionMode === "rotate") {
      viewTheta = thetaForHalfLitDay(realSun, camYaw);
      viewPhi = VIEW_PHI_DEFAULT;
      spinPoseSeeded = true;
    }
    applyCameraYaw();
    persistViewPose(viewTheta, viewPhi, camYaw, globeId);
    viewInitialized = true;
  }
  const DRAG_PHI_MIN = -0.85;
  const DRAG_PHI_MAX = 0.95;
  const DRAG_SENS = 0.0032;
  const DRAG_INERTIA = 0.78;
  const ROTATE_PHI = VIEW_PHI_DEFAULT;

  function applyInteractionMode(mode: "rotate" | "drag") {
    if (mode === interactionMode) return; // no-op — never treat as drag→rotate
    const prev = interactionMode;
    interactionMode = mode;
    dragVelX = 0;
    dragVelY = 0;
    if (mode === "drag") {
      canvas.style.cursor = "grab";
      // Keep current theta/phi/camYaw — user continues from where they were
    } else {
      canvas.style.cursor = "";
      // Resume from the current location; lighting controls own only the light.
      if (prev === "drag") dragPointerId = null;
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
    // Persist every move so remount cannot restore a stale mid-drag snapshot (E3)
    // Yaw only when framed+nonzero; theta/phi always written (persistViewPose merges yaw)
    persistViewPose(
      viewTheta,
      viewPhi,
      sunFramed ? camYaw : undefined,
      globeId,
    );
    lastPosePersist = performance.now();
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
    // Day brightness slider → shader uDayBoost (does not fake sunDir)
    const dayBright = Math.min(2.4, Math.max(0.8, opts.getDayBrightness?.() ?? 1.35));
    dayNightUniforms.uDayBoost.value = dayBright;
    // Limb-friendly fade: hide when clearly behind; full near limb / slightly camera-side
    // (old smoothstep(-0.02,0.12) killed opacity at facing≈0 — Alan fx7b FAIL)
    camAlong.copy(camera.position).normalize();
    const sunFacing = liveSun.dot(camAlong);
    const hideBehind = THREE.MathUtils.smoothstep(sunFacing, -0.25, -0.05);
    // A front-facing sun glyph would sit on top of Earth. Fade the indicator
    // toward full light while the actual illumination stays unchanged.
    const sunFade = hideBehind * (1 - THREE.MathUtils.smoothstep(sunFacing, 0.48, 0.88));
    const limbOut =
      0.1 * (1 - THREE.MathUtils.smoothstep(Math.abs(sunFacing), 0.0, 0.4));
    let sunR = 1.28 + limbOut;
    let beamR = 1.2 + limbOut * 0.85;
    // Project glyph; if near right canvas edge, pull in + shrink beam (Aura flat clip)
    tmp.copy(liveSun).multiplyScalar(sunR);
    tmp.project(camera);
    const ndcX = Math.abs(tmp.x);
    if (ndcX > 0.85) {
      const t = THREE.MathUtils.clamp((ndcX - 0.85) / 0.2, 0, 1);
      sunR *= 1 - 0.18 * t;
      beamR *= 1 - 0.28 * t;
    }
    sunSprite.position.copy(liveSun).multiplyScalar(sunR);
    sunBeam.position.copy(liveSun).multiplyScalar(beamR);
    (sunSprite.material as THREE.SpriteMaterial).opacity = 1.0 * sunFade;
    (sunBeam.material as THREE.SpriteMaterial).opacity = 0.55 * sunFade;
    const sunPulse = 0.5 + 0.5 * Math.sin(time * 0.002);
    let beamScale = 0.5 + 0.07 * sunPulse;
    if (ndcX > 0.85) {
      beamScale *= 1 - 0.35 * THREE.MathUtils.clamp((ndcX - 0.85) / 0.2, 0, 1);
    }
    sunSprite.scale.setScalar(0.28 + 0.05 * sunPulse);
    sunBeam.scale.setScalar(beamScale);

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

    if (outgoingCloudTex) {
      const t = Math.min(1, Math.max(0, (time - cloudTransitionStart) / 1800));
      cloudBlend.uCloudBlend.value = t * t * (3 - 2 * t);
      if (t === 1) finishCloudTransition();
    }
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
    // Drag mode: persist often so remount restores latest tilt (E3 ~33s snap-back)
    const persistEvery = interactionMode === "drag" ? 50 : 250;
    if (time - lastPosePersist > persistEvery) {
      lastPosePersist = time;
      persistViewPose(
        viewTheta,
        viewPhi,
        sunFramed ? camYaw : undefined,
        globeId,
      );
    }

    root.updateMatrixWorld(true);
    syncMarkers(opts.getMarkers(), time);

    const pulse = 0.012 * Math.sin(time * 0.001);
    atmosUniforms.uPulse.value = pulse;
    (hazeMat.uniforms.uPulse as { value: number }).value = pulse;

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  function destroy() {
    disposed = true;
    liveLoadToken++;
    liveCloudAbort?.abort();
    finishCloudTransition();
    persistViewPose(
      viewTheta,
      viewPhi,
      sunFramed ? camYaw : undefined,
      globeId,
    );
    running = false;
    cancelAnimationFrame(raf);
    if (activeGlobeDispose === destroy) activeGlobeDispose = null;
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
    waterMask?.dispose();
    emptyWaterMask.dispose();
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
    animatedCloudTex?.dispose();
    cloudMat.dispose();
    cloudMat2.dispose();
    cloudShadowMat.dispose();
    renderer.dispose();
  }
  activeGlobeDispose = destroy;

  return {
    destroy,
    resize,
    setCloudSource,
    setStarlinkTles,
    getStarlinkDrawn: () => starlinkDrawn,
  };
}
