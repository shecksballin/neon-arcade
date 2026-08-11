/**
 * CELLS WORLD — server-authoritative agar rules (free play v1)
 * ============================================================
 * Design contract scope: world 6000×6000 centered at 0; each player is ONE
 * circle (no split/merge/viruses in v1); radius derives from mass; eat food
 * for mass; eat a player when you are >1.05× their radius AND overlap their
 * circle ≥60%; speed decreases with radius; boost = ×1.8 speed draining
 * 2 mass/s down to a floor; 800 food pellets with ids, respawned to cap
 * each tick, sent to clients as per-player DELTAS {added, removed}.
 *
 * Kills go through World.resolveKill (wagerService Patterns 3+6 + per-kill
 * ELO); cells has NO environment kill in free play (contract).
 *
 * All simulation here is server-owned. The client sends {dx, dy, boost}
 * (validated, magnitude-clamped) and NOTHING else.
 */

import type { Socket } from 'socket.io'
import { SpatialGrid } from './grid'
import { World, type FreeplayWorld } from './world'
import {
  VIEW_RADIUS,
  cellsInputSchema,
  type BaseSession,
  type CellsInput,
  type WorldBounds,
} from './types'

// ─────────────────────────────────────────────────
// Tuning constants (v1 — server-owned, clients render what they're told)
// ─────────────────────────────────────────────────

/** World 6000×6000 centered at the origin (contract). */
const BOUNDS: WorldBounds = { minX: -3000, minY: -3000, maxX: 3000, maxY: 3000 }

/** Grid cell size 400 (contract) — ≈2× a typical blob diameter. */
const GRID_CELL = 400

/** Food: 800 pellets (contract), each worth a small mass bite. */
const FOOD_COUNT = 800
const FOOD_MASS = 6
const FOOD_RADIUS = 8

/** Mass model: spawn at 100, radius = 3·√mass (spawn radius 30). The cap
 *  bounds the biggest blob (radius ≈ 670) so one player can't outgrow the
 *  view radius or the grid. */
const START_MASS = 100
const MAX_MASS = 50_000

/** Boost (contract): ×1.8 speed, drains 2 mass/s, never below spawn mass. */
const BOOST_SPEED_MULT = 1.8
const BOOST_DRAIN_PER_S = 2

/** Speed = f(radius), decreasing: v = 340·(30/r)^0.4, clamped. A spawn
 *  blob does 340 u/s; a max blob crawls at ~100 u/s. */
const BASE_SPEED = 340
const SPAWN_RADIUS = 3 * Math.sqrt(START_MASS)
const MIN_SPEED = 70

/** Eat rules (contract): eater must be >1.05× the victim's radius AND
 *  cover ≥60% of the victim's circle. Coverage ≈ (rBig − dist + rSmall) /
 *  (2·rSmall) ≥ 0.6  ⇔  dist ≤ rBig − 0.2·rSmall. */
const EAT_RADIUS_RATIO = 1.05
const EAT_DIST_FACTOR = 0.2

/** Spawn safety: retry random spots that have a live blob this close. */
const SAFE_SPAWN_DIST = 500
const SPAWN_ATTEMPTS = 12

/** Food-delta hysteresis: a known pellet is only "removed" once it drifts
 *  past 110% of the view radius, so the boundary doesn't flip-flop
 *  add/remove every tick as the player moves. */
const FOOD_FORGET_RADIUS = VIEW_RADIUS * 1.1

// ─────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────

interface Food {
  id: number
  x: number
  y: number
}

/** The cells-specific session: one circle, mass-driven. */
interface CellsSession extends BaseSession<CellsInput> {
  mass: number
  /** Pellet ids this CLIENT currently knows about — the server-side half
   *  of the food-delta protocol. Bounded by what fits in one view circle
   *  (a few hundred), cleared on despawn (long-lived-process hygiene). */
  knownFood: Set<number>
}

const radiusFromMass = (mass: number): number => 3 * Math.sqrt(mass)

const speedFromRadius = (r: number): number =>
  Math.max(MIN_SPEED, BASE_SPEED * Math.pow(SPAWN_RADIUS / r, 0.4))

// ─────────────────────────────────────────────────
// World
// ─────────────────────────────────────────────────

export class CellsWorld extends World<CellsInput, CellsSession> {
  /** Rebuilt every tick before collision resolution (money doc §3). */
  private readonly playerGrid = new SpatialGrid<CellsSession>(GRID_CELL)
  private readonly foodGrid = new SpatialGrid<Food>(GRID_CELL)

  /** id → pellet. Capped at FOOD_COUNT — respawned to cap, never beyond. */
  private readonly foods = new Map<number, Food>()
  private nextFoodId = 1

  // Reused query scratch arrays — cleared per use, never per-tick realloc.
  private readonly queryScratch: CellsSession[] = []
  private readonly foodScratch: Food[] = []

  constructor(matchId: string, entryFee: number, bindings: Map<string, FreeplayWorld>) {
    super('cells', matchId, entryFee, BOUNDS, bindings)
    // Seed the pellet field once; the tick keeps it topped up forever.
    while (this.foods.size < FOOD_COUNT) this.spawnFood()
  }

  // ── game hooks ─────────────────────────────────

  protected parseInput(raw: unknown): CellsInput | null {
    const parsed = cellsInputSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }

  protected newSession(
    id: string,
    wallet: string,
    name: string,
    socket: Socket
  ): CellsSession {
    return {
      ...this.baseFields(id, wallet, name, socket),
      mass: START_MASS,
      knownFood: new Set(),
    }
  }

  /** Fresh life: spawn mass at a random spot clear of other blobs. */
  protected spawn(session: CellsSession): void {
    session.mass = START_MASS
    session.r = radiusFromMass(session.mass)
    // Random safe spot: retry a few times, accept the last try regardless
    // (a busy world beats an infinite loop; worst case is a risky spawn).
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      session.x = BOUNDS.minX + 100 + Math.random() * (BOUNDS.maxX - BOUNDS.minX - 200)
      session.y = BOUNDS.minY + 100 + Math.random() * (BOUNDS.maxY - BOUNDS.minY - 200)
      if (this.isSpawnSafe(session)) break
    }
  }

  /** No live blob within SAFE_SPAWN_DIST of the candidate spot. Scans the
   *  session map directly (spawns are rare; the grid may be mid-rebuild). */
  private isSpawnSafe(session: CellsSession): boolean {
    for (const other of this.sessions.values()) {
      if (other === session || !other.alive) continue
      const dx = other.x - session.x
      const dy = other.y - session.y
      if (dx * dx + dy * dy < SAFE_SPAWN_DIST * SAFE_SPAWN_DIST) return false
    }
    return true
  }

  protected override onDespawn(session: CellsSession): void {
    session.knownFood.clear() // don't pin pellet ids after the player left
  }

  // ── simulation ─────────────────────────────────

  protected step(now: number, dt: number): void {
    // 1) Movement from the last-write-wins input slot. Direction ONLY —
    // magnitude clamped to ≤1 so {1,1} isn't √2 faster (money doc §2).
    for (const s of this.sessions.values()) {
      if (!s.alive) continue
      const input = s.input
      if (input) {
        let dx = input.dx
        let dy = input.dy
        const len = Math.hypot(dx, dy)
        if (len > 1) {
          dx /= len
          dy /= len
        }
        const boosting = input.boost === true && s.mass > START_MASS
        let speed = speedFromRadius(s.r) * this.moveScale(s) // cash-out hold slows
        if (boosting) {
          speed *= BOOST_SPEED_MULT
          // Boost burns mass, but never below the spawn floor (contract).
          s.mass = Math.max(START_MASS, s.mass - BOOST_DRAIN_PER_S * dt)
        }
        s.x += dx * speed * dt
        s.y += dy * speed * dt
      }
      // Server-side clamp to the world box — the only wall there is.
      s.x = Math.min(BOUNDS.maxX, Math.max(BOUNDS.minX, s.x))
      s.y = Math.min(BOUNDS.maxY, Math.max(BOUNDS.minY, s.y))
      s.r = radiusFromMass(s.mass)
    }

    // 2) Rebuild grids AFTER movement, BEFORE collisions (money doc §3).
    this.playerGrid.clear()
    this.foodGrid.clear()
    for (const s of this.sessions.values()) {
      if (s.alive) this.playerGrid.insert(s, s.x, s.y, s.r)
    }
    for (const f of this.foods.values()) {
      this.foodGrid.insert(f, f.x, f.y, FOOD_RADIUS)
    }

    // 3) Eat food: pellet center inside the blob → +mass, pellet gone.
    for (const s of this.sessions.values()) {
      if (!s.alive) continue
      this.foodScratch.length = 0
      const near = this.foodGrid.query(s.x, s.y, s.r, this.foodScratch)
      for (const f of near) {
        if (!this.foods.has(f.id)) continue // eaten earlier THIS tick
        const dx = f.x - s.x
        const dy = f.y - s.y
        if (dx * dx + dy * dy > s.r * s.r) continue
        this.foods.delete(f.id)
        s.mass = Math.min(MAX_MASS, s.mass + FOOD_MASS)
      }
      s.r = radiusFromMass(s.mass)
    }

    // 4) Eat players: bigger blob absorbs smaller on sufficient overlap.
    // Each pair is handled once from the EATER's perspective; a victim
    // flips alive=false immediately (inside resolveKill) so it can't be
    // eaten twice in one tick — the DB status guard is the real backstop.
    for (const s of this.sessions.values()) {
      if (!s.alive) continue
      this.queryScratch.length = 0
      const near = this.playerGrid.query(s.x, s.y, s.r, this.queryScratch)
      for (const other of near) {
        if (other === s || !other.alive || !s.alive) continue
        if (s.r <= other.r * EAT_RADIUS_RATIO) continue // not big enough
        const dx = other.x - s.x
        const dy = other.y - s.y
        const dist = Math.hypot(dx, dy)
        if (dist > s.r - other.r * EAT_DIST_FACTOR) continue // <60% covered
        // Absorb: mass transfers in-world; the POT transfer is settled by
        // wagerService inside resolveKill (async, off this loop).
        s.mass = Math.min(MAX_MASS, s.mass + other.mass)
        s.r = radiusFromMass(s.mass)
        this.resolveKill(s, other)
      }
    }

    // 5) Respawn pellets up to the cap (a few per tick at most).
    while (this.foods.size < FOOD_COUNT) this.spawnFood()

    void now // lifecycle timing is handled by the base class
  }

  private spawnFood(): void {
    const id = this.nextFoodId++
    this.foods.set(id, {
      id,
      x: BOUNDS.minX + Math.random() * (BOUNDS.maxX - BOUNDS.minX),
      y: BOUNDS.minY + Math.random() * (BOUNDS.maxY - BOUNDS.minY),
    })
  }

  // ── interest-managed state (money doc §3) ─────

  protected buildState(session: CellsSession, now: number): Record<string, unknown> {
    // Visible players: grid superset → precise view-circle filter.
    this.queryScratch.length = 0
    const candidates = this.playerGrid.query(
      session.x,
      session.y,
      VIEW_RADIUS,
      this.queryScratch
    )
    const players: Array<Record<string, unknown>> = []
    for (const other of candidates) {
      if (other === session || !other.alive) continue
      const dx = other.x - session.x
      const dy = other.y - session.y
      if (Math.hypot(dx, dy) - other.r > VIEW_RADIUS) continue
      players.push({
        id: other.id, // opaque session id — wallets never leave the server
        name: other.name,
        x: Math.round(other.x),
        y: Math.round(other.y),
        r: Math.round(other.r),
        pot: other.pot, // visible pots ARE the tension of the mode (§3)
      })
    }

    // Food DELTAS against this client's known set (contract): `added` are
    // newly visible pellets, `removed` are pellets that were eaten or left
    // the (hysteresis-padded) view.
    const added: Food[] = []
    const removed: number[] = []
    this.foodScratch.length = 0
    const visibleFood = this.foodGrid.query(
      session.x,
      session.y,
      VIEW_RADIUS,
      this.foodScratch
    )
    for (const f of visibleFood) {
      if (!this.foods.has(f.id) || session.knownFood.has(f.id)) continue
      const dx = f.x - session.x
      const dy = f.y - session.y
      if (dx * dx + dy * dy > VIEW_RADIUS * VIEW_RADIUS) continue
      session.knownFood.add(f.id)
      added.push(f)
    }
    for (const id of session.knownFood) {
      const f = this.foods.get(id)
      if (f) {
        const dx = f.x - session.x
        const dy = f.y - session.y
        if (dx * dx + dy * dy <= FOOD_FORGET_RADIUS * FOOD_FORGET_RADIUS) continue
      }
      session.knownFood.delete(id) // eaten, or out of view — either way gone
      removed.push(id)
    }

    return {
      t: now,
      you: {
        id: session.id,
        x: session.x,
        y: session.y,
        r: session.r,
        mass: Math.round(session.mass),
        pot: session.pot,
        kills: session.kills,
        alive: session.alive,
        respawnIn: session.respawnAt ? Math.max(0, session.respawnAt - now) : 0,
        cashingOut: session.cashout !== 'none',
      },
      players,
      food: { added, removed },
      leaderboard: this.leaderboard,
    }
  }
}
