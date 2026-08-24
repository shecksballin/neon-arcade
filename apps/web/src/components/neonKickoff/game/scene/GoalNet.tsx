import { useFrame } from '@react-three/fiber';
import { BallCollider, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { buildLattice, buildVisualNet, NODE_RADIUS } from '../net';

/**
 * The goal net, simulated.
 *
 * The netting is a lattice over the back curtain. Only the free interior nodes
 * are bodies — the border is lashed to the crossbar, the posts and the ground,
 * so those points never move and live as plain constants. The drawn net rides
 * on top of the lattice at its original 0.22m spacing, in the original colour,
 * so the goal looks untouched until a ball actually hits it.
 *
 * Two deliberate choices here, both learned the hard way:
 *
 * Bodies are <RigidBody> elements rather than world.createRigidBody() calls.
 * Creating them imperatively meant holding raw wasm handles across renders, and
 * under StrictMode <Physics> mounts twice — the second mount builds a new world
 * while the first cleanup frees handles into the old one, which corrupts the
 * wasm heap and takes down the whole app. Letting the library own every handle
 * makes that impossible. The elements never change, so React does no work after
 * mount.
 *
 * There are no joints. Instead each node is sprung back toward where it hangs at
 * rest, which gives the same local billow-and-settle as a mesh of rope joints
 * for a fraction of the solver cost, and removes a second class of hand-managed
 * wasm object entirely.
 */

/** spring pulling a node home: ~1.7Hz, damping ratio ~0.55, so it settles fast */
const STIFFNESS = 120;
const DAMPING = 12;
/** netting stretches, it does not tear away from the frame */
const MAX_STRETCH = 0.55;
/** and it never travels faster than the ball that hit it */
const MAX_SPEED = 14;

export function GoalNet() {
  const lattice = useMemo(buildLattice, []);
  const visual = useMemo(() => buildVisualNet(lattice), [lattice]);

  /** lattice indices that are actually simulated — the border never moves */
  const free = useMemo(
    () => lattice.pinned.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0),
    [lattice]
  );
  const bodies = useRef<(RapierRigidBody | null)[]>([]);
  const lines = useRef<THREE.LineSegments>(null);

  /** current position of every lattice node, pinned ones included */
  const live = useMemo(() => lattice.rest.map((p) => p.clone()), [lattice]);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(visual.cols * visual.rows * 3), 3)
    );
    geo.setIndex(visual.indices);
    // it only ever deforms by a few centimetres, so one generous sphere holds
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.2, -1.3), 6);
    return geo;
  }, [visual]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const mesh = lines.current;
    if (!mesh) return;

    // ---- spring every free node back toward where the netting hangs
    for (let slot = 0; slot < free.length; slot++) {
      const rb = bodies.current[slot];
      if (!rb) continue;
      const n = free[slot];
      const rest = lattice.rest[n];
      const t = rb.translation();
      const v = rb.linvel();

      let dx = rest.x - t.x;
      let dy = rest.y - t.y;
      let dz = rest.z - t.z;
      let px = t.x;
      let py = t.y;
      let pz = t.z;

      // hauled too far out of shape: put it back on the leash
      const stretch = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (stretch > MAX_STRETCH) {
        const pull = (stretch - MAX_STRETCH) / stretch;
        px = t.x + dx * pull;
        py = t.y + dy * pull;
        pz = t.z + dz * pull;
        rb.setTranslation({ x: px, y: py, z: pz }, true);
        // Bleed the speed off too. Clamping the position alone leaves the node
        // still travelling at whatever flung it, so it fights the leash for a
        // dozen frames and the netting boils instead of settling.
        rb.setLinvel({ x: v.x * 0.15, y: v.y * 0.15, z: v.z * 0.15 }, true);
        dx *= MAX_STRETCH / stretch;
        dy *= MAX_STRETCH / stretch;
        dz *= MAX_STRETCH / stretch;
      } else if (v.x * v.x + v.y * v.y + v.z * v.z > MAX_SPEED * MAX_SPEED) {
        // netting does not move faster than a struck ball, whatever hit it
        const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        const scale = MAX_SPEED / speed;
        rb.setLinvel({ x: v.x * scale, y: v.y * scale, z: v.z * scale }, true);
      }

      const mass = rb.mass() || 1;
      rb.resetForces(false);
      rb.addForce(
        {
          x: mass * (STIFFNESS * dx - DAMPING * v.x),
          y: mass * (STIFFNESS * dy - DAMPING * v.y),
          z: mass * (STIFFNESS * dz - DAMPING * v.z),
        },
        true
      );

      // the clamped position, not the raw one: publishing the pre-clamp value
      // draws that node metres out of place for a frame
      live[n].set(px, py, pz);
    }

    // ---- and blend the drawn netting across it
    const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    const { cell, weight } = visual;
    const count = out.length / 3;

    for (let v = 0; v < count; v++) {
      const n = v * 4;
      let x = 0;
      let y = 0;
      let z = 0;
      for (let c = 0; c < 4; c++) {
        const w = weight[n + c];
        if (w === 0) continue;
        const p = live[cell[n + c]];
        x += p.x * w;
        y += p.y * w;
        z += p.z * w;
      }
      out[v * 3] = x;
      out[v * 3 + 1] = y;
      out[v * 3 + 2] = z;
    }
    attr.needsUpdate = true;
  });

  return (
    <>
      {free.map((n, slot) => (
        <RigidBody
          key={n}
          ref={(rb) => {
            bodies.current[slot] = rb;
          }}
          type="dynamic"
          colliders={false}
          position={lattice.rest[n].toArray()}
          gravityScale={0}
          linearDamping={0}
          angularDamping={6}
          enabledRotations={[false, false, false]}
        >
          <BallCollider args={[NODE_RADIUS]} density={4} restitution={0.02} friction={0.9} />
        </RigidBody>
      ))}

      <lineSegments ref={lines} geometry={geometry} frustumCulled={false}>
        <lineBasicMaterial color="#8ffff0" transparent opacity={0.32} />
      </lineSegments>
    </>
  );
}
