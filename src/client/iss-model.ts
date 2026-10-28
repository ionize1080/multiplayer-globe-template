import * as THREE from "three";

/** Stylized metallic ISS — truss, modules, solar arrays. Unit-scale ~1 ≈ station length. */
export function createIssModel(): THREE.Group {
  const root = new THREE.Group();
  root.name = "iss";

  const metal = new THREE.MeshStandardMaterial({
    color: 0xc8d4e8,
    metalness: 0.92,
    roughness: 0.28,
    emissive: 0x1e3a5f,
    emissiveIntensity: 0.15,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    metalness: 0.7,
    roughness: 0.35,
    emissive: 0x0ea5e9,
    emissiveIntensity: 0.45,
  });
  const panel = new THREE.MeshStandardMaterial({
    color: 0x0b1f3a,
    metalness: 0.55,
    roughness: 0.4,
    emissive: 0x0369a1,
    emissiveIntensity: 0.55,
  });
  const panelEdge = new THREE.MeshStandardMaterial({
    color: 0x7dd3fc,
    metalness: 0.8,
    roughness: 0.25,
    emissive: 0x22d3ee,
    emissiveIntensity: 0.35,
  });
  const gold = new THREE.MeshStandardMaterial({
    color: 0xfbbf24,
    metalness: 0.85,
    roughness: 0.35,
    emissive: 0xb45309,
    emissiveIntensity: 0.2,
  });

  // Central truss (along +X)
  const truss = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 0.08), metal);
  root.add(truss);
  for (let i = -1; i <= 1; i += 1) {
    const cross = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.22), metal);
    cross.position.x = i * 0.7;
    root.add(cross);
  }

  // Destiny / Columbus / Kibo style pressurized modules along +Z/-Z
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

  // Node sphere
  const node = new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 16), metal);
  node.position.set(0.05, 0.02, 0.02);
  root.add(node);

  // Cupola hint
  const cupola = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.06, 12), gold);
  cupola.position.set(0.05, -0.14, 0.02);
  root.add(cupola);

  // Radiators (white-ish)
  const radMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    metalness: 0.4,
    roughness: 0.55,
    emissive: 0x94a3b8,
    emissiveIntensity: 0.08,
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
      // cell lines
      for (let c = -2; c <= 2; c++) {
        const line = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.017, 0.52), panelEdge);
        line.position.set(arr.position.x + c * 0.14, 0.002, 0);
        line.material = panelEdge;
        wing.add(line);
      }
    }
    root.add(wing);
  }

  addSolarWing(1);
  addSolarWing(-1);

  // Soft beacon light
  const beacon = new THREE.PointLight(0x67e8f9, 1.4, 2.5, 2);
  beacon.position.set(0, 0.2, 0);
  root.add(beacon);

  // Overall scale applied by caller; normalize bounding
  root.scale.setScalar(1);
  return root;
}
