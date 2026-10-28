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
  const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 100);
  // Pull back so Earth + atmosphere (~1.12) + orbit fit with margin (was FOV42@2.85 → clipped L/R).
  camera.position.set(0, 0.22, 3.55);

  const root = new THREE.Group();
  scene.add(root);

  // Lights
  scene.add(new THREE.AmbientLight(0xa5d8ff, 0.78));
  const key = new THREE.DirectionalLight(0xdbeafe, 1.05);
  key.position.set(3.2, 2.4, 3.5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7dd3fc, 0.7);
  rim.position.set(-3, -1, -2);
  scene.add(rim);

  // Earth
  const earthGroup = new THREE.Group();
  // Leave breathing room inside the square viewport / circular canvas clip
  earthGroup.scale.setScalar(0.9);
  root.add(earthGroup);

  const earthGeo = new THREE.SphereGeometry(1, 96, 96);
  // Physical material: matte land, soft water sheen (not plastic chrome)
  const earthMat = new THREE.MeshPhysicalMaterial({
    color: 0x122038,
    roughness: 1,
    metalness: 0,
    emissive: 0x0c1a2e,
    emissiveIntensity: 0.55,
    clearcoat: 0.02,
    clearcoatRoughness: 0.9,
    reflectivity: 0.05,
    specularIntensity: 0.08,
    specularColor: new THREE.Color(0x64748b),
  });
  const earth = new THREE.Mesh(earthGeo, earthMat);
  earthGroup.add(earth);

  /** Water mask (white=ocean) → roughness map: land matte, ocean softly reflective */
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
      const water = d[i]! / 255; // oceans bright in earth-water.png
      // land ~1.0 rough; ocean ~0.68 — soft water, not mirror
      const rough = 1 - water * 0.18; // oceans only slightly smoother
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

  const loader = new THREE.TextureLoader();
  // NASA Blue Marble / night lights via three-globe CDN; clouds via three.js examples
  const TEX = "https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img";
  const CLOUD_TEX =
    "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/earth_clouds_1024.png";

  loader.load(
    `${TEX}/earth-blue-marble.jpg`,
    (day) => {
      day.colorSpace = THREE.SRGBColorSpace;
      day.anisotropy = 8;
      earthMat.map = day;
      earthMat.color.set(0xffffff);
      earthMat.needsUpdate = true;
    },
    undefined,
    () => {
      /* fallback night-only below */
    },
  );
  loader.load(
    `${TEX}/earth-night.jpg`,
    (night) => {
      night.colorSpace = THREE.SRGBColorSpace;
      night.anisotropy = 8;
      earthMat.emissiveMap = night;
      earthMat.emissive.set(0x9bb8d4);
      earthMat.emissiveIntensity = 1.05;
      if (!earthMat.map) {
        earthMat.map = night;
        earthMat.color.set(0xffffff);
      }
      earthMat.needsUpdate = true;
    },
    undefined,
    () => {
      /* keep solid fallback */
    },
  );
  loader.load(
    `${TEX}/earth-water.png`,
    (waterTex) => {
      earthMat.roughnessMap = waterToSoftRoughnessMap(waterTex);
      earthMat.roughness = 1;
      earthMat.metalness = 0;
      earthMat.clearcoat = 0.025;
      earthMat.clearcoatRoughness = 0.88;
      earthMat.needsUpdate = true;
      waterTex.dispose();
    },
    undefined,
    () => {
      /* no water mask */
    },
  );

  // Drifting cloud layer (randomized start phase)
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    emissive: 0x1e293b,
    emissiveIntensity: 0.08,
  });
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.015, 64, 64), cloudMat);
  clouds.rotation.y = Math.random() * Math.PI * 2;
  clouds.rotation.z = (Math.random() - 0.5) * 0.08;
  earthGroup.add(clouds);
  const cloudDrift = 0.00012 + Math.random() * 0.00008;
  loader.load(
    CLOUD_TEX,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      cloudMat.map = tex;
      cloudMat.alphaMap = tex;
      cloudMat.needsUpdate = true;
    },
    undefined,
    () => {
      clouds.visible = false;
    },
  );

  // Fresnel atmosphere (three.js) — parented to earthGroup so zoom/rotation track Earth
  const atmosUniforms = {
    uGlowColor: { value: new THREE.Color(0x1e3a5f) },
    uRimColor: { value: new THREE.Color(0x38bdf8) },
    uIntensity: { value: 0.55 },
    uPower: { value: 3.8 },
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
        vec3 col = mix(uGlowColor, uRimColor, smoothstep(0.0, 1.0, fresnel));
        float alpha = fresnel * 0.42;
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
  const atmos = new THREE.Mesh(new THREE.SphereGeometry(1.028, 64, 64), atmosMat);
  earthGroup.add(atmos);

  // Soft outer haze shell (also three.js, same group)
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
        float a = fresnel * (0.12 + uPulse * 0.5);
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
  const atmosOuter = new THREE.Mesh(new THREE.SphereGeometry(1.055, 48, 48), hazeMat);
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
      const mesh = markerPool[i];
      const data = list[i];
      if (!data) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.material = data.self ? markerMatSelf : markerMatOther;
      const s = Math.max(0.0045, Math.min(0.012, data.size * 0.09));
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
    // satellite.js ECI velocity is km/s — keep km/s (do not *1000).
    let velocity = 0;
    if (velocityEci) {
      velocity = Math.sqrt(
        velocityEci.x * velocityEci.x +
          velocityEci.y * velocityEci.y +
          velocityEci.z * velocityEci.z,
      );
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
    // Always render into a *square* viewport matching the CSS box.
    // Percentage height on the canvas can resolve before the aspect-ratio
    // parent has a height → clientWidth >> clientHeight → flattened globe.
    const box = canvas.parentElement ?? canvas;
    const css = Math.max(
      1,
      Math.round(Math.min(box.clientWidth || 0, box.clientHeight || 0) || canvas.clientWidth || 520),
    );
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(css, css, false);
    // Keep CSS square fill; avoid three.js writing non-square inline styles.
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
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => resize())
      : null;
  ro?.observe(canvas.parentElement ?? canvas);

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

      const pulse = 0.065 + 0.012 * Math.sin(time * 0.004);
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

    clouds.rotation.y += cloudDrift;

    phi += opts.getRotationSpeed();
    root.rotation.y = phi;
    root.rotation.x = 0.18;

    // gentle atmosphere pulse
    const pulse = 0.015 * Math.sin(time * 0.001);
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
      renderer.dispose();
    },
    resize,
  };
}
