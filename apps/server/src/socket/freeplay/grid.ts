/**
 * SPATIAL GRID — uniform buckets with radius queries
 * ==================================================
 * The scaling primitive from the money doc §3: bucket the world into fixed
 * cells so collision checks and interest-management queries touch only the
 * handful of cells near a point instead of every entity in the world
 * (O(n²) → roughly O(n)).
 *
 * Usage pattern (per the doc: "rebuild or update the grid once per tick,
 * before collision resolution"):
 *
 *   grid.clear()
 *   for (const e of entities) grid.insert(e, e.x, e.y, e.r)
 *   const nearby = grid.query(x, y, radius)
 *
 * Semantics:
 * - `insert` registers the item in EVERY cell its bounding box (x±r, y±r)
 *   overlaps, so an entity larger than a cell (a fat Cells blob) is still
 *   found from any cell it touches.
 * - `query` returns every item whose inserted bounding box overlaps the
 *   query circle's bounding box — a SUPERSET of the true circle overlaps.
 *   Callers do the precise distance check themselves (they need per-entity
 *   radii for game rules anyway). Guarantee: if two circles overlap, their
 *   AABBs overlap, and two overlapping AABBs always share at least one grid
 *   cell — so no true overlap is ever missed.
 *
 * LONG-LIVED-PROCESS NOTES (money doc §7):
 * - `clear()` empties bucket arrays but KEEPS them, so a grid reaches a
 *   steady state of at most (worldWidth/cellSize)² buckets and then stops
 *   allocating — no per-tick Map churn.
 * - Query deduplication reuses one scratch Set per grid (single-threaded
 *   tick loop → safe), so queries allocate only their result array.
 */

export class SpatialGrid<T> {
  /** Packed (cx, cy) → items whose AABB overlaps that cell. */
  private readonly buckets = new Map<number, T[]>()

  /** Reusable dedupe set for queries (items span multiple cells). */
  private readonly scratch = new Set<T>()

  constructor(private readonly cellSize: number) {}

  // ── key packing ────────────────────────────────
  // Cell coords are small (world ≤ ~8000 / cellSize ≥ 400 → tens of cells,
  // possibly negative for origin-centered worlds). Offset by 2^15 and pack
  // into one integer — cheaper keys than `${cx},${cy}` strings.
  private static key(cx: number, cy: number): number {
    return (cx + 0x8000) * 0x10000 + (cy + 0x8000)
  }

  private cellCoord(v: number): number {
    return Math.floor(v / this.cellSize)
  }

  /** Empty every bucket but keep the arrays (steady-state, no churn). */
  clear(): void {
    for (const bucket of this.buckets.values()) bucket.length = 0
  }

  /**
   * Register `item` in every cell overlapped by the box (x±r, y±r).
   * `r` defaults to 0 for point entities (food pellets, bullets).
   */
  insert(item: T, x: number, y: number, r = 0): void {
    const minCx = this.cellCoord(x - r)
    const maxCx = this.cellCoord(x + r)
    const minCy = this.cellCoord(y - r)
    const maxCy = this.cellCoord(y + r)
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = SpatialGrid.key(cx, cy)
        let bucket = this.buckets.get(key)
        if (!bucket) {
          bucket = []
          this.buckets.set(key, bucket)
        }
        bucket.push(item)
      }
    }
  }

  /**
   * Every item whose inserted AABB overlaps the (x±radius, y±radius) box —
   * a superset of the circle overlaps; callers distance-filter precisely.
   * Results are pushed into `out` (pass an array to reuse allocations).
   */
  query(x: number, y: number, radius: number, out: T[] = []): T[] {
    const minCx = this.cellCoord(x - radius)
    const maxCx = this.cellCoord(x + radius)
    const minCy = this.cellCoord(y - radius)
    const maxCy = this.cellCoord(y + radius)
    this.scratch.clear()
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this.buckets.get(SpatialGrid.key(cx, cy))
        if (!bucket) continue
        for (const item of bucket) {
          if (this.scratch.has(item)) continue // spans multiple cells
          this.scratch.add(item)
          out.push(item)
        }
      }
    }
    this.scratch.clear() // don't pin entity references between ticks
    return out
  }
}
