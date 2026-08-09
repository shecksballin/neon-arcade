import * as THREE from 'three';

// Map geometry is boxy in both kits, so axis-aligned boxes are an honest collision proxy
// and cost nothing compared to per-triangle raycasts. Which mesh counts as what comes
// from the map's own entry in maps.js — see the note there about names vs materials.
const CELL = 8;
const key = (cx, cz) => `${cx},${cz}`;

// A whole-mesh bounding box is far too fat for this kit: it swallows roof overhangs and
// the long horizontal arm of a street light, so you collide with — and shoot into — thin
// air. Take the footprint from the lower slice of the mesh instead, which is the part you
// can actually walk into, and keep the full height for the vertical extent.
const FOOTPRINT_SLICE = 0.55;   // fraction of the height used for the footprint
// Walls need to stay solid, so barely shave them. Decorative props are rounded/irregular
// and a rectangle around them overshoots badly, so those get pulled in much harder.
const INSET_BUILDING = 0.06;
const INSET_PROP = 0.3;

const footprintCache = new Map();

// A mesh's identity is its name plus its material's name — see maps.js.
export function labelOf(mesh) {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return `${mesh.name} ${material?.name ?? ''}`;
}

function localFootprint(geometry) {
  const cached = footprintCache.get(geometry.uuid);
  if (cached) return cached;

  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const pos = geometry.attributes.position;
  const cutoff = bb.min.y + (bb.max.y - bb.min.y) * FOOTPRINT_SLICE;

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, found = 0;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > cutoff) continue;
    const x = pos.getX(i), z = pos.getZ(i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    found++;
  }

  // degenerate (flat mesh, or everything above the cut) — fall back to the full box
  const box = found > 2
    ? new THREE.Box3(
        new THREE.Vector3(minX, bb.min.y, minZ),
        new THREE.Vector3(maxX, bb.max.y, maxZ))
    : bb.clone();

  footprintCache.set(geometry.uuid, box);
  return box;
}

export function buildCollision(map, patterns) {
  const { solid: SOLID, ground: GROUND, prop: PROP } = patterns;
  const solids = [];
  const grounds = [];
  const box = new THREE.Box3();

  map.updateWorldMatrix(true, true);
  map.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    const label = labelOf(child);
    const solid = SOLID.test(label);

    if (solid) box.copy(localFootprint(child.geometry)).applyMatrix4(child.matrixWorld);
    else {
      if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
      box.copy(child.geometry.boundingBox).applyMatrix4(child.matrixWorld);
    }

    // don't let the inset invert a genuinely thin object (a pole, a fence panel)
    const inset = PROP.test(label) ? INSET_PROP : INSET_BUILDING;
    const insetX = Math.min(inset, (box.max.x - box.min.x) * 0.25);
    const insetZ = Math.min(inset, (box.max.z - box.min.z) * 0.25);

    const entry = solid ? {
      minX: box.min.x + insetX, maxX: box.max.x - insetX,
      minY: box.min.y, maxY: box.max.y,
      minZ: box.min.z + insetZ, maxZ: box.max.z - insetZ,
    } : {
      minX: box.min.x, maxX: box.max.x,
      minY: box.min.y, maxY: box.max.y,
      minZ: box.min.z, maxZ: box.max.z,
    };

    if (solid) solids.push(entry);
    else if (GROUND.test(label)) grounds.push(entry);
  });

  // spatial hash so lookups only touch nearby boxes
  const solidGrid = new Map();
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    for (let cx = Math.floor(s.minX / CELL); cx <= Math.floor(s.maxX / CELL); cx++) {
      for (let cz = Math.floor(s.minZ / CELL); cz <= Math.floor(s.maxZ / CELL); cz++) {
        const k = key(cx, cz);
        let bucket = solidGrid.get(k);
        if (!bucket) solidGrid.set(k, bucket = []);
        bucket.push(s);
      }
    }
  }

  const groundGrid = new Map();
  const bigGrounds = [];   // meshes spanning many cells (the base plane) — checked always
  for (const g of grounds) {
    const spanX = Math.floor(g.maxX / CELL) - Math.floor(g.minX / CELL);
    const spanZ = Math.floor(g.maxZ / CELL) - Math.floor(g.minZ / CELL);
    if (spanX > 6 || spanZ > 6) { bigGrounds.push(g); continue; }
    for (let cx = Math.floor(g.minX / CELL); cx <= Math.floor(g.maxX / CELL); cx++) {
      for (let cz = Math.floor(g.minZ / CELL); cz <= Math.floor(g.maxZ / CELL); cz++) {
        const k = key(cx, cz);
        let bucket = groundGrid.get(k);
        if (!bucket) groundGrid.set(k, bucket = []);
        bucket.push(g);
      }
    }
  }

  // `mapBounds` is every last triangle; `bounds` is only where there is ground to stand on.
  // On the city map those are near enough the same, but a warehouse's roof overhang and
  // outdoor props push the model's extent a couple of metres past its floor — and anything
  // that samples or clamps against that extent puts entities outside the building, in mid
  // air. Everything that asks the collider about the play area gets the floor's extent.
  const mapBounds = new THREE.Box3().setFromObject(map);
  const bounds = new THREE.Box3();
  for (const g of grounds) {
    bounds.expandByPoint(new THREE.Vector3(g.minX, g.minY, g.minZ));
    bounds.expandByPoint(new THREE.Vector3(g.maxX, g.maxY, g.maxZ));
  }
  if (bounds.isEmpty()) bounds.copy(mapBounds);

  function nearbySolids(x, z, pad = 0) {
    const out = [];
    const cx0 = Math.floor((x - pad) / CELL), cx1 = Math.floor((x + pad) / CELL);
    const cz0 = Math.floor((z - pad) / CELL), cz1 = Math.floor((z + pad) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const bucket = solidGrid.get(key(cx, cz));
        if (bucket) for (const s of bucket) if (!out.includes(s)) out.push(s);
      }
    }
    return out;
  }

  // Highest ground surface under a point.
  function groundAt(x, z) {
    let y = -Infinity;
    const bucket = groundGrid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (bucket) {
      for (const g of bucket) {
        if (x >= g.minX && x <= g.maxX && z >= g.minZ && z <= g.maxZ && g.maxY > y) y = g.maxY;
      }
    }
    for (const g of bigGrounds) {
      if (x >= g.minX && x <= g.maxX && z >= g.minZ && z <= g.maxZ && g.maxY > y) y = g.maxY;
    }
    return y === -Infinity ? 0 : y;
  }

  // Push a capsule out of any box it overlaps, on the shallowest axis.
  function resolve(pos, radius, height) {
    const feet = pos.y;
    const head = pos.y + height;
    for (const s of nearbySolids(pos.x, pos.z, radius + 1)) {
      if (head < s.minY + 0.05 || feet > s.maxY - 0.05) continue;   // clear above or below
      const overlapX = Math.min(pos.x + radius - s.minX, s.maxX - (pos.x - radius));
      const overlapZ = Math.min(pos.z + radius - s.minZ, s.maxZ - (pos.z - radius));
      if (overlapX <= 0 || overlapZ <= 0) continue;
      if (overlapX < overlapZ) {
        pos.x += (pos.x < (s.minX + s.maxX) * 0.5) ? -overlapX : overlapX;
      } else {
        pos.z += (pos.z < (s.minZ + s.maxZ) * 0.5) ? -overlapZ : overlapZ;
      }
    }
    // keep everyone inside the map
    pos.x = THREE.MathUtils.clamp(pos.x, bounds.min.x + 2, bounds.max.x - 2);
    pos.z = THREE.MathUtils.clamp(pos.z, bounds.min.z + 2, bounds.max.z - 2);
  }

  // Slab test — used for bullets and for AI line of sight.
  function rayHit(origin, dir, maxDist) {
    let best = maxDist;
    const steps = Math.ceil(maxDist / CELL) + 1;
    const seen = new Set();
    for (let i = 0; i <= steps; i++) {
      const t = Math.min(i * CELL, maxDist);
      const px = origin.x + dir.x * t;
      const pz = origin.z + dir.z * t;
      for (const s of nearbySolids(px, pz, CELL)) {
        if (seen.has(s)) continue;
        seen.add(s);
        const d = slabIntersect(origin, dir, s);
        if (d !== null && d < best) best = d;
      }
    }
    return best < maxDist ? best : null;
  }

  function slabIntersect(o, d, s) {
    let tmin = 0, tmax = Infinity;
    for (const [oc, dc, lo, hi] of [
      [o.x, d.x, s.minX, s.maxX],
      [o.y, d.y, s.minY, s.maxY],
      [o.z, d.z, s.minZ, s.maxZ],
    ]) {
      if (Math.abs(dc) < 1e-8) {
        if (oc < lo || oc > hi) return null;
      } else {
        let t1 = (lo - oc) / dc, t2 = (hi - oc) / dc;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) return null;
      }
    }
    return tmin;
  }

  const _dir = new THREE.Vector3();
  function lineOfSight(from, to) {
    _dir.subVectors(to, from);
    const dist = _dir.length();
    if (dist < 0.001) return true;
    _dir.divideScalar(dist);
    const hit = rayHit(from, _dir, dist);
    return hit === null;
  }

  // Does a character standing here overlap a building or a prop? Only the boxes know
  // about, so physics.js replaces this with a real capsule test when Rapier is up.
  function isClear(x, y, z) {
    for (const s of nearbySolids(x, z, 1.6)) {
      if (s.maxY < y + 0.4) continue;
      if (x > s.minX - 1.2 && x < s.maxX + 1.2 && z > s.minZ - 1.2 && z < s.maxZ + 1.2) return false;
    }
    return true;
  }

  // Open spots on roads/lawns, used for spawns and AI waypoints.
  function findOpenPoint(random = Math.random) {
    for (let i = 0; i < 60; i++) {
      const x = bounds.min.x + random() * (bounds.max.x - bounds.min.x);
      const z = bounds.min.z + random() * (bounds.max.z - bounds.min.z);
      const y = groundAt(x, z);
      if (isClear(x, y, z)) return new THREE.Vector3(x, y, z);
    }
    return new THREE.Vector3(0, groundAt(0, 0), 0);
  }

  return { solids, grounds, bounds, mapBounds, groundAt, resolve, rayHit, lineOfSight, findOpenPoint, isClear, nearbySolids };
}
