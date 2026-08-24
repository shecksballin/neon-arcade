import * as THREE from 'three';

export type Dir = 'left' | 'middle' | 'right';
export type Zone = 'green' | 'orange' | 'red';
export type Side = 'player' | 'ai';

export type Phase =
  | 'intro'   // round banner — "ROUND N, YOU STRIKE / AI STRIKES"
  | 'aim'     // player is the striker, timing ring live, waiting for A/W/D
  | 'guard'   // player is the keeper, AI striker winding up, A/D to commit a dive
  | 'strike'  // ball in flight (either side kicked)
  | 'result'  // GOAL / SAVED / OVER THE BAR banner
  | 'over';   // shootout decided

export type Outcome = 'goal' | 'saved' | 'off';

export interface KickData {
  kicker: Side;
  dir: Dir;
  zone: Zone;
  outcome: Outcome;
  /** which way the defending keeper went (AI guess when player kicks, player guess when AI kicks) */
  guess: Dir;
}

// ---- pitch geometry (meters). Goal line at z = 0, mouth opens toward +z,
// penalty spot 11m out. Goal mouth 7.32 x 2.44 (regulation).
export const GOAL_W = 7.32;
export const GOAL_H = 2.44;
export const SPOT = new THREE.Vector3(0, 0.111, 11);
export const BALL_R = 0.111;

/** where a shot in each lane crosses the goal line, per timing zone */
export function shotTarget(dir: Dir, zone: Zone, outcome: Outcome): THREE.Vector3 {
  const lane = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
  if (outcome === 'off') {
    // skied — sails over the crossbar in the chosen lane
    return new THREE.Vector3(lane * 2.2, GOAL_H + 1.6, 0);
  }
  if (dir === 'middle') {
    // "straight down the middle" — driven at waist height
    return new THREE.Vector3(0, zone === 'green' ? 0.95 : 1.25, 0);
  }
  // corners: green buries it top corner, orange drifts central and lower
  const x = lane * (zone === 'green' ? 2.95 : 2.2);
  const y = zone === 'green' ? 1.95 : 1.45;
  return new THREE.Vector3(x, y, 0);
}

/** where the keeper gets a hand to a correctly-guessed shot */
export function saveContact(dir: Dir, zone: Zone): THREE.Vector3 {
  const lane = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
  if (dir === 'middle') return new THREE.Vector3(0, 1.0, 0.7);
  return new THREE.Vector3(lane * (zone === 'green' ? 2.5 : 1.9), 1.5, 0.55);
}

/**
 * All Dir values in game state live in STRIKER space (left = striker's left).
 * The keeper sees the pitch mirrored, so keeper-facing keys and copy flip L/R.
 */
export function flipDir(d: Dir): Dir {
  return d === 'left' ? 'right' : d === 'right' ? 'left' : d;
}

/** world x sign for a striker-space direction (+x is the striker's right) */
export function dirX(d: Dir): number {
  return d === 'left' ? -1 : d === 'right' ? 1 : 0;
}
