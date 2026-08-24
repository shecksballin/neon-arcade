import { useMemo } from 'react';
import * as THREE from 'three';
import { SPOT } from '../types';

/**
 * The pitch outlines.
 *
 * The stadium model paints running-track lanes on its grass rather than football
 * markings, so Stadium hides those and we lay our own down instead.
 *
 * Only the attacking third is drawn. A full pitch puts a halfway line and centre
 * circle in shot behind the striker, which in a third-person view reads as
 * clutter stretching off into the dark — and none of it is anything the player
 * can act on. What is left is the goal line, the boxes, the spot and the D.
 *
 * Drawn as thin quads rather than lines because WebGL ignores line width, so
 * THREE.Line would give hairlines that shimmer at this distance.
 */
const LINE_W = 0.12;
const Y = 0.014; // just proud of the turf, so it never z-fights

const PITCH_W = 68;
/** how far up the pitch the markings run — kept inside the turf's fade so no
 *  line is ever left hanging over nothing */
const DRAWN_L = 16.5;
const BOX_W = 40.32;
const BOX_D = 16.5;
const SIX_W = 18.32;
const SIX_D = 5.5;
const ARC_R = 9.15;

interface Stripe {
  x: number;
  z: number;
  len: number;
  angle: number;
}

function seg(x1: number, z1: number, x2: number, z2: number): Stripe {
  const dx = x2 - x1;
  const dz = z2 - z1;
  return {
    x: (x1 + x2) / 2,
    z: (z1 + z2) / 2,
    len: Math.hypot(dx, dz) + LINE_W,
    angle: Math.atan2(dz, dx),
  };
}

function arc(cx: number, cz: number, r: number, from: number, to: number, steps: number): Stripe[] {
  const out: Stripe[] = [];
  for (let i = 0; i < steps; i++) {
    const a0 = from + ((to - from) * i) / steps;
    const a1 = from + ((to - from) * (i + 1)) / steps;
    out.push(
      seg(cx + r * Math.cos(a0), cz + r * Math.sin(a0), cx + r * Math.cos(a1), cz + r * Math.sin(a1))
    );
  }
  return out;
}

function buildPitch(): Stripe[] {
  const hp = PITCH_W / 2;
  const hb = BOX_W / 2;
  const hs = SIX_W / 2;
  const out: Stripe[] = [];

  // goal line, plus the touchlines running back only as far as the fog
  out.push(seg(-hp, 0, hp, 0));
  out.push(seg(-hp, 0, -hp, DRAWN_L), seg(hp, 0, hp, DRAWN_L));

  // our penalty area and six-yard box
  out.push(seg(-hb, 0, -hb, BOX_D), seg(hb, 0, hb, BOX_D), seg(-hb, BOX_D, hb, BOX_D));
  out.push(seg(-hs, 0, -hs, SIX_D), seg(hs, 0, hs, SIX_D), seg(-hs, SIX_D, hs, SIX_D));

  // the D — only the sliver of the arc that falls outside the box
  const cut = Math.acos(Math.min(1, (BOX_D - SPOT.z) / ARC_R));
  out.push(...arc(0, SPOT.z, ARC_R, cut, Math.PI - cut, 24));

  return out;
}

export function PitchLines() {
  const stripes = useMemo(buildPitch, []);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        // a touch over 1.0 so the bloom pass gives the paint a soft lift,
        // without turning the markings into light strips of their own
        color: new THREE.Color('#eafffb').multiplyScalar(1.15),
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
      }),
    []
  );

  return (
    <group>
      {stripes.map((s, i) => (
        <mesh
          key={i}
          position={[s.x, Y, s.z]}
          rotation={[-Math.PI / 2, 0, -s.angle]}
          material={material}
        >
          <planeGeometry args={[s.len, LINE_W]} />
        </mesh>
      ))}

      {/* the penalty spot — small and dim on purpose: the striker's camera sits
          barely two metres off it, so anything brighter reads as a glowing puddle */}
      <mesh position={[SPOT.x, Y, SPOT.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.075, 20]} />
        <meshBasicMaterial color="#dff7f2" transparent opacity={0.7} depthWrite={false} />
      </mesh>
    </group>
  );
}
