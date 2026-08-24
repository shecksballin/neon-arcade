import * as THREE from 'three';
import { backSurfaceZ } from './net';
import { BALL_R, SPOT, saveContact, shotTarget, type KickData } from './types';

/** seconds from boot contact to the goal line, per timing zone */
const CROSS_TIME = { green: 0.55, orange: 0.8, red: 0.95 } as const;

export interface FlightPath {
  /** seconds until the ball reaches the goal line / keeper */
  cross: number;
  /** full length of the flight including the follow-through segment */
  total: number;
  /** where the ball meets the line — the point the keeper has to reach */
  contact: THREE.Vector3;
  /** sample the ball position at time t (seconds since contact) into `out` */
  at(t: number, out: THREE.Vector3): THREE.Vector3;
}

function quad(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3) {
  const u = 1 - t;
  out.set(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    u * u * a.z + 2 * u * t * c.z + t * t * b.z
  );
  return out;
}

/** control point that lifts the ball into a believable arc between two points */
function arcCtrl(a: THREE.Vector3, b: THREE.Vector3, lift: number): THREE.Vector3 {
  return new THREE.Vector3((a.x + b.x) / 2, Math.max(a.y, b.y) + lift, (a.z + b.z) / 2);
}

export function makeFlight(kick: KickData): FlightPath {
  const p0 = SPOT.clone();
  const isSave = kick.outcome === 'saved';
  const end1 = isSave
    ? saveContact(kick.dir, kick.zone)
    : shotTarget(kick.dir, kick.zone, kick.outcome);
  const cross = CROSS_TIME[kick.zone] * (isSave ? 0.94 : 1);

  // flight to the line: skied balls climb hard, clean strikes stay flat
  const lift = kick.outcome === 'off' ? 1.1 : kick.zone === 'orange' ? 0.55 : 0.18;
  const c1 = arcCtrl(p0, end1, lift);

  // follow-through
  let end2: THREE.Vector3;
  let c2: THREE.Vector3;
  let dur2: number;
  if (kick.outcome === 'goal') {
    // Carry on into the netting rather than stopping short of it: the follow-
    // through used to end around z=-1.05, a good half metre in front of where
    // the curtain actually hangs, so the ball never reached the net to move it.
    const y2 = Math.max(BALL_R, end1.y * 0.45);
    end2 = new THREE.Vector3(end1.x * 0.85, y2, backSurfaceZ(y2) - 0.04);
    c2 = arcCtrl(end1, end2, 0.05);
    dur2 = 0.36;
  } else if (kick.outcome === 'off') {
    end2 = new THREE.Vector3(end1.x * 1.7, BALL_R, -13);
    c2 = arcCtrl(end1, end2, 0.9);
    dur2 = 1.0;
  } else if (kick.dir === 'middle') {
    // caught clean — the ball just dies in the keeper's chest
    end2 = new THREE.Vector3(0, 0.95, 0.78);
    c2 = arcCtrl(end1, end2, 0.02);
    dur2 = 0.28;
  } else {
    // parried wide, bouncing back out toward the corner flag
    const side = Math.sign(end1.x) || 1;
    end2 = new THREE.Vector3(side * 4.2, BALL_R, 3.4);
    c2 = arcCtrl(end1, end2, 0.8);
    dur2 = 0.75;
  }

  const total = cross + dur2;
  return {
    cross,
    total,
    contact: end1,
    at(t, out) {
      if (t <= 0) return out.copy(p0);
      if (t < cross) return quad(p0, c1, end1, t / cross, out);
      if (t < total) return quad(end1, c2, end2, (t - cross) / dur2, out);
      return out.copy(end2);
    },
  };
}
