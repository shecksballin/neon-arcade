import * as THREE from 'three';

// Phase 5 — instanced, wind-animated grass.
// Blades are scattered by raycasting straight down onto the map and keeping only the
// hits that land on open lawn (anything that isn't road, building or prop).
const BLOCKED = /road|driveway|building|light|planter|tree|construction|barrier|cone|fence/i;

export function createGrass(mapRoot, {
  clusters = 3000,    // raycast samples — the expensive part
  perCluster = 8,     // blades spawned per accepted sample, jittered, no extra rays
  area = 92,          // half-extent of the scatter square, in world units
  gradientMap = null,
  color = '#7ac74f',
} = {}) {
  const blade = new THREE.PlaneGeometry(0.055, 0.24, 1, 3);
  blade.translate(0, 0.12, 0);   // pivot at the root, so the tips are the part that bends

  const material = new THREE.MeshToonMaterial({
    color: new THREE.Color(color),
    gradientMap,
    side: THREE.DoubleSide,
  });

  const uniforms = { uTime: { value: 0 } };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float uTime;\nvoid main() {')
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 bladePos = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
        #else
          vec2 bladePos = vec2(0.0);
        #endif
        // tips sway, roots stay planted
        float bend = pow(uv.y, 2.0);
        float phase = uTime * 1.7 + bladePos.x * 0.33 + bladePos.y * 0.21;
        transformed.x += sin(phase) * 0.09 * bend;
        transformed.z += cos(phase * 0.77) * 0.05 * bend;
      `);
  };
  material.customProgramCacheKey = () => 'grass-wind';

  const raycaster = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0);
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  const tint = new THREE.Color();

  const mesh = new THREE.InstancedMesh(blade, material, clusters * perCluster);
  mesh.castShadow = false;      // tens of thousands of shadow casters is not worth the frame time
  mesh.receiveShadow = false;   // sampling the shadow map per blade fragment isn't worth it either
  mesh.frustumCulled = false;   // one draw call covering the whole map

  // firstHitOnly needs three-mesh-bvh, which isn't installed — so trim the work per ray
  // instead: a straight-down ray can only hit a mesh whose world bounds straddle the
  // sample's XZ column, and pre-boxing every mesh once makes that test cheap.
  const meshBounds = [];
  mapRoot.traverse((o) => {
    if (o.isMesh) meshBounds.push({ mesh: o, box: new THREE.Box3().setFromObject(o) });
  });
  const candidates = [];

  const axisY = new THREE.Vector3(0, 1, 0);
  let placed = 0;
  let samples = 0;
  let attempts = 0;
  const maxAttempts = clusters * 4;

  while (samples < clusters && attempts < maxAttempts) {
    attempts++;
    const cx = (Math.random() * 2 - 1) * area;
    const cz = (Math.random() * 2 - 1) * area;
    origin.set(cx, 40, cz);
    raycaster.set(origin, down);
    candidates.length = 0;
    for (const { mesh: m, box } of meshBounds) {
      if (cx >= box.min.x && cx <= box.max.x && cz >= box.min.z && cz <= box.max.z) candidates.push(m);
    }
    const hit = raycaster.intersectObjects(candidates, false)[0];
    if (!hit || BLOCKED.test(hit.object.name)) continue;
    samples++;

    const y = hit.point.y - 0.01;
    for (let i = 0; i < perCluster; i++) {
      const x = cx + (Math.random() - 0.5) * 0.9;
      const z = cz + (Math.random() - 0.5) * 0.9;
      position.set(x, y, z);
      quat.setFromAxisAngle(axisY, Math.random() * Math.PI);
      const s = 0.7 + Math.random() * 0.8;
      scale.set(s, s * (0.75 + Math.random() * 0.7), s);
      mesh.setMatrixAt(placed, matrix.compose(position, quat, scale));

      tint.setHSL(0.24 + Math.random() * 0.05, 0.35 + Math.random() * 0.16, 0.4 + Math.random() * 0.12);
      mesh.setColorAt(placed, tint);
      placed++;
    }
  }

  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  mesh.tick = (elapsed) => { uniforms.uTime.value = elapsed; };
  mesh.userData.placed = placed;
  return mesh;
}
