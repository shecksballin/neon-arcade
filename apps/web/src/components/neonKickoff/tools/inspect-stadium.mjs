/**
 * Where does every part of the stadium actually end up, and what sits behind the
 * striker?
 *
 * Reproduces Stadium.tsx's placement offline so the scene can be measured with
 * no browser. Decodes POSITION accessors directly, including the quantised ones
 * KHR_mesh_quantization leaves behind, because the interesting geometry (the
 * model's own goal, the pitch-side barrier) is merged into meshes shared with
 * the stands and cannot be found from material bounds alone.
 *
 *   node tools/inspect-stadium.mjs
 */
import fs from 'node:fs';
import * as THREE from 'three';

const PITCH_LENGTH = 105;
const FIELD_CENTRE_Z = 52.5;
const HIDDEN = new Set(['Field Markup', 'Back Banners', 'Field Banners', 'Field']);

const buf = fs.readFileSync('public/assets/stadium.glb');
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const bin = buf.slice(binStart);

const READ = {
  5120: [1, (b, o) => b.readInt8(o) / 127],
  5121: [1, (b, o) => b.readUInt8(o) / 255],
  5122: [2, (b, o) => Math.max(b.readInt16LE(o) / 32767, -1)],
  5123: [2, (b, o) => b.readUInt16LE(o) / 65535],
  5125: [4, (b, o) => b.readUInt32LE(o)],
  5126: [4, (b, o) => b.readFloatLE(o)],
};
const RAW = {
  5120: (b, o) => b.readInt8(o),
  5121: (b, o) => b.readUInt8(o),
  5122: (b, o) => b.readInt16LE(o),
  5123: (b, o) => b.readUInt16LE(o),
  5125: (b, o) => b.readUInt32LE(o),
  5126: (b, o) => b.readFloatLE(o),
};

function readPositions(accessorIndex) {
  const acc = json.accessors[accessorIndex];
  const view = json.bufferViews[acc.bufferView];
  const [width] = READ[acc.componentType];
  const decode = acc.normalized ? READ[acc.componentType][1] : RAW[acc.componentType];
  const stride = view.byteStride || width * 3;
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const out = new Float32Array(acc.count * 3);
  for (let i = 0; i < acc.count; i++) {
    const at = base + i * stride;
    out[i * 3] = decode(bin, at);
    out[i * 3 + 1] = decode(bin, at + width);
    out[i * 3 + 2] = decode(bin, at + width * 2);
  }
  return out;
}

const world = new Map();
(function build() {
  const walk = (index, parent) => {
    const node = json.nodes[index];
    const local = new THREE.Matrix4();
    if (node.matrix) local.fromArray(node.matrix);
    else
      local.compose(
        new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]),
        new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
        new THREE.Vector3().fromArray(node.scale ?? [1, 1, 1])
      );
    const m = new THREE.Matrix4().multiplyMatrices(parent, local);
    world.set(index, m);
    for (const child of node.children ?? []) walk(child, m);
  };
  const id = new THREE.Matrix4();
  for (const scene of json.scenes) for (const root of scene.nodes) walk(root, id);
})();

// ---- pass 1: bounds per material, to derive the same placement Stadium.tsx uses
const bounds = new Map();
const parts = [];
const corner = new THREE.Vector3();
for (const [index, m] of world) {
  const node = json.nodes[index];
  if (node.mesh === undefined) continue;
  for (const prim of json.meshes[node.mesh].primitives) {
    const acc = json.accessors[prim.attributes.POSITION];
    if (!acc?.min) continue;
    const name = prim.material !== undefined ? json.materials[prim.material].name : '(none)';
    parts.push({ name, accessor: prim.attributes.POSITION, matrix: m });
    if (!bounds.has(name)) bounds.set(name, new THREE.Box3());
    const box = bounds.get(name);
    // gltf-transform's quantiser writes min/max as raw integers even on a
    // normalized accessor, so they have to be scaled the same way the renderer
    // scales the vertex data — otherwise bounds and vertices disagree by 32767x
    const q = acc.normalized ? 1 / 32767 : 1;
    for (let i = 0; i < 8; i++) {
      corner.set(
        (i & 1 ? acc.max[0] : acc.min[0]) * q,
        (i & 2 ? acc.max[1] : acc.min[1]) * q,
        (i & 4 ? acc.max[2] : acc.min[2]) * q
      );
      box.expandByPoint(corner.applyMatrix4(m));
    }
  }
}

const field = bounds.get('Field');
const size = field.getSize(new THREE.Vector3());
const place = new THREE.Matrix4();
if (size.x > size.z) place.makeRotationY(Math.PI / 2);
const rotated = field.clone().applyMatrix4(place);
const scale = PITCH_LENGTH / Math.max(rotated.getSize(new THREE.Vector3()).z, 1e-9);
place.premultiply(new THREE.Matrix4().makeScale(scale, scale, scale));
const scaled = field.clone().applyMatrix4(place);
const centre = scaled.getCenter(new THREE.Vector3());
place.premultiply(
  new THREE.Matrix4().makeTranslation(-centre.x, -scaled.max.y - 0.01, FIELD_CENTRE_Z - centre.z)
);

// ---- pass 2: for what stays visible, where does geometry actually sit down the
// pitch, in the corridor a goal or a barrier would occupy?
const STRIKER_Z = 13.1;
const BUCKET = 4;
const histogram = new Map();
const p = new THREE.Vector3();

for (const part of parts) {
  if (HIDDEN.has(part.name)) continue;
  const pos = readPositions(part.accessor);
  const m = new THREE.Matrix4().multiplyMatrices(place, part.matrix);
  for (let i = 0; i < pos.length; i += 3) {
    p.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(m);
    if (Math.abs(p.x) > 10 || p.y > 6 || p.y < -0.5) continue; // goal-sized corridor
    if (p.z < STRIKER_Z) continue;
    const bucket = Math.floor(p.z / BUCKET) * BUCKET;
    const key = `${part.name}|${bucket}`;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
}

console.log(`scale=${scale.toExponential(3)}  striker at z=${STRIKER_Z}\n`);
console.log('Visible geometry down the middle of the pitch, behind the striker:');
console.log('material            z range      vertices');
[...histogram.entries()]
  .map(([k, n]) => {
    const [name, z] = k.split('|');
    return { name, z: Number(z), n };
  })
  .sort((a, b) => a.z - b.z || b.n - a.n)
  .filter((r) => r.n > 20)
  .slice(0, 24)
  .forEach((r) =>
    console.log(`${r.name.padEnd(19)} ${String(r.z).padStart(4)}..${String(r.z + BUCKET).padEnd(4)}  ${r.n}`)
  );
