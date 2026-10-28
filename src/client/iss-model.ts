import * as THREE from "three";

/** Stylized ISS — subdued materials (no chrome hot spots / Earth-lighting beacon). */
export function createIssModel(): THREE.Group {
  const root = new THREE.Group();
  root.name = "iss";

  const metal = new THREE.MeshStandardMaterial({
    color: 0xb8c4d6,
    metalness: 0.35,
    roughness: 0.62,
    emissive: 0x0b1220,
    emissiveIntensity: 0.04,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0x5b9ec9,
    metalness: 0.25,
    roughness: 0.55,
    emissive: 0x0c4a6e,
    emissiveIntensity: 0.12,
  });
  const panel = new THREE.MeshStandardMaterial({
    color: 0x0a1628,
    metalness: 0.2,
    roughness: 0.7,
    emissive: 0x082f49,
    emissiveIntensity: 0.18,
  });
  const panelEdge = new THREE.MeshStandardMaterial({
    color: 0x4a90b8,
    metalness: 0.3,
    roughness: 0.55,
    emissive: 0x155e75,
    emissiveIntensity: 0.1,
  });
  const gold = new THREE.MeshStandardMaterial({
    color: 0xd4a017,
    metalness: 0.4,
    roughness: 0.55,
    emissive: 0x5c3d0a,
    emissiveIntensity: 0.06,
  });

  const truss = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 0.08), metal);
  root.add(truss);
  for (let i = -1; i <= 1; i += 1) {
    const cross = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.22), metal);
    cross.position.x = i * 0.7;
    root.add(cross);
  }

  const moduleGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.55, 16);
  const m1 = new THREE.Mesh(moduleGeo, metal);
  m1.rotation.z = Math.PI / 2;
  m1.position.set(-0.15, 0, 0.28);
  root.add(m1);
  const m2 = new THREE.Mesh(moduleGeo, accent);
  m2.rotation.z = Math.PI / 2;
  m2.position.set(0.2, 0, -0.22);
  m2.scale.set(0.85, 0.9, 0.85);
  root.add(m2);

  const node = new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 16), metal);
  node.position.set(0.05, 0.02, 0.02);
  root.add(node);

  const cupola = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.06, 12), gold);
  cupola.position.set(0.05, -0.14, 0.02);
  root.add(cupola);

  const radMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    metalness: 0.15,
    roughness: 0.75,
    emissive: 0x334155,
    emissiveIntensity: 0.03,
  });
  for (const z of [-0.42, 0.42]) {
    const rad = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.02, 0.28), radMat);
    rad.position.set(0.55, 0.12, z * 0.15);
    rad.rotation.x = z > 0 ? 0.35 : -0.35;
    root.add(rad);
  }

  function addSolarWing(xSign: number) {
    const wing = new THREE.Group();
    const boom = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.04), metal);
    boom.position.x = xSign * 1.55;
    wing.add(boom);

    for (let i = 0; i < 2; i++) {
      const arr = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.015, 0.55), panel);
      arr.position.set(xSign * (1.2 + i * 0.95), 0, 0);
      wing.add(arr);
      const rim = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.006, 0.02), panelEdge);
      rim.position.set(arr.position.x, 0.012, 0.275);
      wing.add(rim);
      const rim2 = rim.clone();
      rim2.position.z = -0.275;
      wing.add(rim2);
      for (let c = -2; c <= 2; c++) {
        const line = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.017, 0.52), panelEdge);
        line.position.set(arr.position.x + c * 0.14, 0.002, 0);
        wing.add(line);
      }
    }
    root.add(wing);
  }

  addSolarWing(1);
  addSolarWing(-1);

  // Tiny marker light only — must NOT light the Earth (was causing white hotspot)
  const beacon = new THREE.PointLight(0x67e8f9, 0.08, 0.35, 2);
  beacon.position.set(0, 0.15, 0);
  root.add(beacon);

  return root;
}
