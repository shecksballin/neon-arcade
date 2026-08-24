import type { Zone } from './types';

/**
 * The strike-timing ring. One cycle runs big -> small then snaps back to big.
 * cycleT 0 = biggest (red), 1 = smallest (deep green sweet spot).
 * The longer the striker stalls, the shorter the period — it pulses faster.
 */
export const RING_MAX_R = 1.05; // meters, biggest radius of the glow circle
export const RING_MIN_R = 0.24;

export const ORANGE_AT = 0.52; // cycleT where red hands over to orange
export const GREEN_AT = 0.82;  // cycleT where orange hands over to green

export function ringPeriod(elapsed: number): number {
  // 1.6s per pulse at first, accelerating to 0.6s after ~9 seconds of stalling
  return Math.max(0.6, 1.6 - 0.115 * elapsed);
}

export function ringZone(cycleT: number): Zone {
  if (cycleT >= GREEN_AT) return 'green';
  if (cycleT >= ORANGE_AT) return 'orange';
  return 'red';
}

export function ringRadius(cycleT: number): number {
  const e = 1 - (1 - cycleT) * (1 - cycleT); // ease-out: lingers near the small end
  return RING_MAX_R + (RING_MIN_R - RING_MAX_R) * e;
}

export const ZONE_COLOR: Record<Zone, string> = {
  red: '#ff2438',
  orange: '#ff9a1f',
  green: '#2bff8f',
};
