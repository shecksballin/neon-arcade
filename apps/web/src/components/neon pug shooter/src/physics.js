import * as THREE from 'three';
import { buildCollision } from './collision.js';

// Exact map collision via Rapier.
//
// This is the same engine @react-three/rapier wraps — we call it directly because this
// project is plain three.js with no React or bundler. Every map mesh is baked into one
// static trimesh, so bullets, line of sight and character movement all test against the
// real triangles instead of a box approximation.
//
// The box collider from collision.js is still built, but only for what it's genuinely
// good at: flat ground-plate heights and picking open spawn points.

const DEG = Math.PI / 180;

/**
 * A stable handle in front of a swappable physics world.
 *
 * The player and every bot capture `collision` in their closures at construction, so
 * changing maps can't simply hand out a new object — it has to be the same one with
 * different guts. Forwarding is written out at fixed arity rather than with rest args
 * because rayHit and moveCapsule run per bullet, per bot, per frame, and `...args` would
 * allocate an array on every one of those calls.
 */
export function createCollisionHandle() {
  let impl = null;
  return {
    // The worlds behind this are cached and reused, so swapping never frees one.
    swap(next) { impl = next; },
    get bounds() { return impl.bounds; },
    get mapBounds() { return impl.mapBounds; },
    get solids() { return impl.solids; },
    get grounds() { return impl.grounds; },
    get exact() { return impl.exact; },
    get stats() { return impl.stats; },
    groundAt: (x, z) => impl.groundAt(x, z),
    resolve: (pos, radius, height) => impl.resolve(pos, radius, height),
    rayHit: (origin, dir, maxDist) => impl.rayHit(origin, dir, maxDist),
    lineOfSight: (from, to) => impl.lineOfSight(from, to),
    findOpenPoint: (random) => impl.findOpenPoint(random),
    isClear: (x, y, z) => impl.isClear(x, y, z),
    standable: (x, y, z) => impl.standable(x, y, z),
    nearbySolids: (x, z, pad) => impl.nearbySolids(x, z, pad),
    moveCapsule: (key, pos, radius, height, dx, dy, dz, velocity) =>
      impl.moveCapsule(key, pos, radius, height, dx, dy, dz, velocity),
    releaseCapsule: (key) => impl.releaseCapsule(key),
    update: () => impl.update(),
  };
}

export async function buildPhysics(map, patterns, onProgress = () => {}) {
  const boxes = buildCollision(map, patterns);   // ground grid + spawn sampling
  let RAPIER;

  try {
    onProgress('starting physics', 0.1);
    RAPIER = (await import('@dimforge/rapier3d-compat')).default;
    await RAPIER.init();
  } catch (err) {
    console.warn('Rapier unavailable — falling back to box collision', err);
    return {
      ...boxes, exact: false, update() {},
      standable: boxes.isClear,          // no trimesh to probe for a floor
      moveCapsule: boxFallbackMove(boxes), releaseCapsule() {},
    };
  }

  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });   // we integrate our own gravity

  // ---- bake the map into a single static trimesh
  onProgress('baking collision mesh', 0.4);
  map.updateWorldMatrix(true, true);

  let vertexCount = 0;
  let indexCount = 0;
  map.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    vertexCount += o.geometry.attributes.position.count;
    indexCount += o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count;
  });

  const vertices = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const v = new THREE.Vector3();
  let vi = 0;
  let ii = 0;
  let base = 0;

  map.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      vertices[vi++] = v.x;
      vertices[vi++] = v.y;
      vertices[vi++] = v.z;
    }
    const index = o.geometry.index;
    if (index) for (let i = 0; i < index.count; i++) indices[ii++] = index.getX(i) + base;
    else for (let i = 0; i < pos.count; i++) indices[ii++] = i + base;
    base += pos.count;
  });

  const mapBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices), mapBody);

  // ---- character controller: capsule sweeps with autostep and slope handling
  const controller = world.createCharacterController(0.02);
  controller.enableAutostep(0.45, 0.3, true);     // kerbs and low props
  controller.enableSnapToGround(0.4);
  controller.setMaxSlopeClimbAngle(55 * DEG);
  controller.setMinSlopeSlideAngle(38 * DEG);
  controller.setApplyImpulsesToDynamicBodies(false);

  const rigs = new Map();
  function rigFor(key, radius, height) {
    let rig = rigs.get(key);
    const halfHeight = Math.max(0.05, height / 2 - radius);
    if (rig && Math.abs(rig.halfHeight - halfHeight) < 1e-3 && Math.abs(rig.radius - radius) < 1e-3) return rig;
    if (rig) { world.removeCollider(rig.collider, false); world.removeRigidBody(rig.body); }

    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    const collider = world.createCollider(RAPIER.ColliderDesc.capsule(halfHeight, radius), body);
    rig = { body, collider, radius, halfHeight, height };
    rigs.set(key, rig);
    return rig;
  }

  const _desired = { x: 0, y: 0, z: 0 };

  /**
   * Slide a capsule through the world. `position` is the entity's feet and is written
   * back in place; returns whether it ended up standing on something.
   */
  function moveCapsule(key, position, radius, height, dx, dy, dz, velocity = null) {
    const rig = rigFor(key, radius, height);
    // Kinematic bodies only move on step(), so set the transform outright — and leave the
    // body asleep. Waking it marks the query pipeline dirty, and the next character query
    // then rebuilds the BVH over all 235k map triangles: ~600us per entity per frame.
    rig.body.setTranslation({ x: position.x, y: position.y + height / 2, z: position.z }, false);

    _desired.x = dx; _desired.y = dy; _desired.z = dz;
    controller.computeColliderMovement(rig.collider, _desired);
    const moved = controller.computedMovement();

    position.x += moved.x;
    position.y += moved.y;
    position.z += moved.z;

    // the map is a finite plate — without this you can simply walk off the edge
    position.x = Math.min(Math.max(position.x, boxes.bounds.min.x + 2), boxes.bounds.max.x - 2);
    position.z = Math.min(Math.max(position.z, boxes.bounds.min.z + 2), boxes.bounds.max.z - 2);

    // Cancel only the part of the velocity heading into each surface we touched. Deriving
    // velocity from the movement that actually happened looks equivalent but isn't: on a
    // landing frame the controller trims the whole step while resolving ground contact,
    // which would scrub off the horizontal speed a bunny hop just earned.
    if (velocity) {
      const n = controller.numComputedCollisions();
      for (let i = 0; i < n; i++) {
        const hit = controller.computedCollision(i);
        const normal = hit?.normal1 ?? hit?.normal2;
        if (!normal) continue;
        const into = velocity.x * normal.x + velocity.y * normal.y + velocity.z * normal.z;
        if (into >= 0) continue;                 // already moving away from it
        velocity.x -= normal.x * into;
        velocity.y -= normal.y * into;
        velocity.z -= normal.z * into;
      }
    }

    return controller.computedGrounded();
  }

  function releaseCapsule(key) {
    const rig = rigs.get(key);
    if (!rig) return;
    world.removeCollider(rig.collider, false);
    world.removeRigidBody(rig.body);
    rigs.delete(key);
  }

  // ---- exact rays: bullets, line of sight, camera pull-in
  //
  // ONLY_FIXED restricts queries to the map body. Without it every ray also hits the
  // character capsules, which are kinematic — and since a ray for the camera or for a
  // bot's own line of sight starts *inside* its owner's capsule, it reports a hit at
  // distance 0. That reads as an invisible wall glued to the player.
  const MAP_ONLY = RAPIER.QueryFilterFlags.ONLY_FIXED;
  const _ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });

  function rayHit(origin, dir, maxDist) {
    _ray.origin.x = origin.x; _ray.origin.y = origin.y; _ray.origin.z = origin.z;
    _ray.dir.x = dir.x; _ray.dir.y = dir.y; _ray.dir.z = dir.z;
    const hit = world.castRay(_ray, maxDist, true, MAP_ONLY);
    if (!hit) return null;
    // renamed across Rapier versions
    const t = hit.timeOfImpact ?? hit.toi;
    return t <= maxDist ? t : null;
  }

  const _losDir = new THREE.Vector3();
  function lineOfSight(from, to) {
    _losDir.subVectors(to, from);
    const dist = _losDir.length();
    if (dist < 0.001) return true;
    _losDir.divideScalar(dist);
    // stop a touch short so standing against a wall doesn't blind you to yourself
    return rayHit(from, _losDir, dist - 0.05) === null;
  }

  // ---- spawn points that are actually clear
  //
  // The box collider only knows about buildings and props, so it happily hands back a
  // point inside a tree — which the trimesh then treats as solid, trapping whoever
  // spawned there. Overlap-test the real geometry with a capsule before accepting.
  const spawnShape = new RAPIER.Capsule(0.58, 0.45);   // a little roomier than a character
  // Lifted clear of the floor: the ground is part of the same trimesh, and a capsule whose
  // tip sits exactly on it can register the road itself as an obstruction — which would
  // fail every test and send us to the fallback with a point nobody vetted.
  const SPAWN_RISE = 1.15;
  const _spawnPos = { x: 0, y: 0, z: 0 };
  const _spawnRot = { x: 0, y: 0, z: 0, w: 1 };

  function isClear(x, y, z) {
    _spawnPos.x = x; _spawnPos.y = y + SPAWN_RISE; _spawnPos.z = z;
    return world.intersectionWithShape(_spawnPos, _spawnRot, spawnShape, MAP_ONLY) === null;
  }

  // Clear of geometry isn't the same as standing on something. Past an interior map's
  // walls there is nothing to overlap *and* nothing underfoot, so an open-air point looks
  // perfect right up until whoever spawns or walks there drops out of the world.
  const _floorFrom = new THREE.Vector3();
  const DOWN = new THREE.Vector3(0, -1, 0);
  function hasFloor(x, y, z) {
    _floorFrom.set(x, y + 1, z);
    return rayHit(_floorFrom, DOWN, 2.4) !== null;
  }

  const standable = (x, y, z) => isClear(x, y, z) && hasFloor(x, y, z);

  // Fitting is not the same as belonging. The slot between a crate stack and the wall
  // passes a character-sized test and is still a rotten place to put someone — they arrive
  // wedged in a corner staring at cardboard. Spawns want elbow room, so prefer somewhere a
  // torso-height ball fits. A ball rather than a capsule because a capsule wide enough to
  // mean anything here would poke through the floor.
  const ROOM_RADIUS = 1.15;
  const roomShape = new RAPIER.Ball(ROOM_RADIUS);
  function hasRoom(x, y, z) {
    _spawnPos.x = x; _spawnPos.y = y + ROOM_RADIUS + 0.15; _spawnPos.z = z;
    return world.intersectionWithShape(_spawnPos, _spawnRot, roomShape, MAP_ONLY) === null;
  }

  // A rejected sample is usually only just inside something — a tree trunk, a planter lip,
  // the corner of a porch. Sweep outwards before throwing the whole sample away.
  const RING_RADII = [1.4, 2.8, 4.2, 6];
  const RING_STEPS = 10;
  function nudgeClear(p, random) {
    for (const radius of RING_RADII) {
      const phase = random() * Math.PI * 2;
      for (let i = 0; i < RING_STEPS; i++) {
        const a = phase + (i / RING_STEPS) * Math.PI * 2;
        const x = p.x + Math.cos(a) * radius;
        const z = p.z + Math.sin(a) * radius;
        const y = boxes.groundAt(x, z);
        if (standable(x, y, z)) return new THREE.Vector3(x, y, z);
      }
    }
    return null;
  }

  // Last resort, walked once and cached: a coarse pass over the whole plate. Only reached
  // if sampling gets pathologically unlucky, and it still returns a vetted point rather
  // than the blocked one that sampling gave up on.
  let vetted = null;
  function sweepForOpenPoints() {
    if (vetted) return vetted;
    vetted = [];
    const { min, max } = boxes.bounds;
    for (let x = min.x + 4; x < max.x && vetted.length < 32; x += 4) {
      for (let z = min.z + 4; z < max.z && vetted.length < 32; z += 4) {
        const y = boxes.groundAt(x, z);
        if (standable(x, y, z) && hasRoom(x, y, z)) vetted.push(new THREE.Vector3(x, y, z));
      }
    }
    return vetted;
  }

  function findOpenPoint(random = Math.random) {
    let cramped = null;                 // somewhere legal but tight — the consolation prize
    for (let i = 0; i < 40; i++) {
      const p = boxes.findOpenPoint(random);
      const spot = standable(p.x, p.y, p.z) ? p : nudgeClear(p, random);
      if (!spot) continue;
      if (hasRoom(spot.x, spot.y, spot.z)) return spot;
      cramped ??= spot;
    }
    if (cramped) return cramped;
    const pool = sweepForOpenPoints();
    if (pool.length) return pool[Math.floor(random() * pool.length)].clone();
    return new THREE.Vector3(0, boxes.groundAt(0, 0), 0);
  }

  function update() {
    world.step();
  }

  // A world that has never been stepped answers no scene queries: every ray and shape cast
  // reports empty until the pipeline is built. Spawn points are chosen the instant a match
  // starts, which is before the first frame — so without this, nothing is ever standable,
  // every entity gets the same fallback point, and the solver shoves the pile apart into
  // whatever scenery is nearest. Step once here so the collider is live when it is handed over.
  world.step();

  return {
    ...boxes,
    exact: true,
    rayHit,
    lineOfSight,
    findOpenPoint,
    isClear,
    standable,
    moveCapsule,
    releaseCapsule,
    update,
    stats: { triangles: indexCount / 3, vertices: vertexCount },
  };
}

// If Rapier can't load, drive movement the old way so the game still runs.
function boxFallbackMove(boxes) {
  return (key, position, radius, height, dx, dy, dz) => {
    position.x += dx;
    position.y += dy;
    position.z += dz;
    boxes.resolve(position, radius, height);
    const floor = boxes.groundAt(position.x, position.z);
    if (position.y <= floor + 0.01) { position.y = floor; return true; }
    return false;
  };
}
