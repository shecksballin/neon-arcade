import * as THREE from 'three';
import { GOAL_H, GOAL_W } from './types';

/**
 * The goal netting, as one shared surface definition.
 *
 * The visual net, the physics lattice that drives it and the ball's
 * follow-through all have to agree on exactly where the netting hangs, so the
 * geometry lives here rather than being re-derived in three places.
 */
export const NET_DEPTH_TOP = 0.9;
export const NET_DEPTH_BOTTOM = 1.7;

/** spacing of the drawn netting — the look, unchanged */
export const VISUAL_STEP = 0.22;
/**
 * Spacing of the simulated lattice. Coarser than the drawn net on purpose: the
 * drawn vertices are interpolated across it, so a few hundred bodies buy a net
 * that still reads as fine mesh. Chosen so that a ball can never thread between
 * four nodes without touching one — see NODE_RADIUS.
 */
export const PHYSICS_STEP = 0.35;

/**
 * Radius of a lattice node's collider.
 *
 * A ball can sit at worst in the middle of a cell, half a diagonal from every
 * node. Anything smaller than that distance minus the ball's own radius would
 * let a shot pass clean through the netting without disturbing it.
 */
export const NODE_RADIUS = 0.15;

/** how far back the curtain hangs at a given height — it leans away from goal */
export function backSurfaceZ(y: number): number {
  const k = 1 - y / GOAL_H;
  return -NET_DEPTH_TOP - (NET_DEPTH_BOTTOM - NET_DEPTH_TOP) * k;
}

/** a point on the back curtain, u across the goal and v up it, both 0..1 */
export function netPoint(u: number, v: number, out = new THREE.Vector3()): THREE.Vector3 {
  const y = v * GOAL_H;
  return out.set(-GOAL_W / 2 + u * GOAL_W, y, backSurfaceZ(y));
}

export interface Lattice {
  cols: number;
  rows: number;
  /** rest positions, indexed row-major as row * cols + col */
  rest: THREE.Vector3[];
  /** true where the netting is lashed to the frame and cannot move */
  pinned: boolean[];
  /** neighbour pairs to link with rope joints, as index pairs */
  links: [number, number][];
}

function gridCount(span: number, step: number) {
  return Math.max(2, Math.round(span / step) + 1);
}

export function buildLattice(): Lattice {
  const cols = gridCount(GOAL_W, PHYSICS_STEP);
  const rows = gridCount(GOAL_H, PHYSICS_STEP);
  const rest: THREE.Vector3[] = [];
  const pinned: boolean[] = [];

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      rest.push(netPoint(i / (cols - 1), j / (rows - 1)));
      // lashed along the crossbar, both posts and the ground
      pinned.push(i === 0 || i === cols - 1 || j === 0 || j === rows - 1);
    }
  }

  const links: [number, number][] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * cols + i;
      if (i + 1 < cols) links.push([a, a + 1]);
      if (j + 1 < rows) links.push([a, a + cols]);
    }
  }

  return { cols, rows, rest, pinned, links };
}

export interface VisualNet {
  cols: number;
  rows: number;
  /** line-segment index pairs over the visual grid */
  indices: number[];
  /** per visual vertex: the four lattice nodes it is interpolated from */
  cell: Uint32Array;
  /** per visual vertex: the bilinear weights for those four nodes */
  weight: Float32Array;
}

/**
 * Build the drawn net, and work out once how each of its vertices rides on the
 * coarser physics lattice. Every frame after that is a bilinear blend of four
 * node positions per vertex, which is cheap enough to do for the whole curtain.
 */
export function buildVisualNet(lattice: Lattice): VisualNet {
  const cols = gridCount(GOAL_W, VISUAL_STEP);
  const rows = gridCount(GOAL_H, VISUAL_STEP);
  const count = cols * rows;
  const cell = new Uint32Array(count * 4);
  const weight = new Float32Array(count * 4);

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1);
      const v = j / (rows - 1);

      const gx = u * (lattice.cols - 1);
      const gy = v * (lattice.rows - 1);
      const i0 = Math.min(Math.floor(gx), lattice.cols - 2);
      const j0 = Math.min(Math.floor(gy), lattice.rows - 2);
      const fx = gx - i0;
      const fy = gy - j0;

      const n = (j * cols + i) * 4;
      cell[n] = j0 * lattice.cols + i0;
      cell[n + 1] = j0 * lattice.cols + i0 + 1;
      cell[n + 2] = (j0 + 1) * lattice.cols + i0;
      cell[n + 3] = (j0 + 1) * lattice.cols + i0 + 1;
      weight[n] = (1 - fx) * (1 - fy);
      weight[n + 1] = fx * (1 - fy);
      weight[n + 2] = (1 - fx) * fy;
      weight[n + 3] = fx * fy;
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * cols + i;
      if (i + 1 < cols) indices.push(a, a + 1);
      if (j + 1 < rows) indices.push(a, a + cols);
    }
  }

  return { cols, rows, indices, cell, weight };
}
