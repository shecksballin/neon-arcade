/**
 * CELLS WORLD — server-authoritative agar rules
 * =============================================
 * ONE engine, three modes (free_play permanent world, slayer + lms
 * match-scoped lobbies). The mode lives entirely in World; this file is
 * pure simulation.
 *
 * PRACTICE PARITY (contract: "Online play must feel EXACTLY like practice")
 * Every constant below is lifted verbatim from the practice engine
 * `apps/web/src/components/Cells/gameEngine.ts`:
 *   world            6000 × 6000 centred on the origin
 *   spawn radius     15                (was 30 here — "spawns too big")
 *   food             1500 pellets, radius 8, +0.5 radius per pellet
 *   eat player       r > other.r * 1.1 && dist < r - other.r * 0.3
 *                    → r += other.r * 0.3
 *   movement         v += dir * (3.6 / √r * 45) per 60 fps frame,
 *                    v *= 0.9 per frame, pos += v * dt
 *   boost            ×1.65 acceleration, 5 s earned per kill (stackable)
 *   score            +1 per pellet, +20 per player eaten
 * The practice loop integrates per animation frame, so movement here runs
 * in fixed 1/60 s sub-steps (3 per 20 Hz tick) instead of one big step —
 * that is what makes the numbers transfer instead of merely rhyming.
 *
 * THE SHRINKING SAFE ZONE (contract: "Zone simulation in match worlds")
 * A match world runs the practice difficulty code the lobby derived from
 * (sector, mode) — 10/11 ECLIPSE, 12/13 BLITZ — and with it the SAME zone
 * state machine practice runs (`gameEngine.ts`, `update()`): a full-world
 * red zone that interpolates onto a randomly-placed next safe zone for a
 * timed shrink phase, holds for a stabilization phase, then repeats with a
 * fresh target. Outside the red ring is INSTANT death, exactly as practice.
 * The permanent free-play world runs difficulty 1 — no zone, nothing here
 * changes for it.
 *
 * The client sends {dx, dy, boost} (validated, magnitude-clamped) and
 * NOTHING else; positions are never trusted. The zone is likewise
 * server-authoritative: it is simulated here and SHIPPED in the snapshot
 * (`state.zone`), so no client ever runs a second, divergent zone.
 */

import type { Socket } from 'socket.io'
import { SpatialGrid } from './grid'
import { World, type FreeplayWorld, type WorldOptions } from './world'
import {
  SUBSTEPS_PER_TICK,
  SUBSTEP_DT,
  cellsInputSchema,
  type BaseSession,
  type CellsInput,
  type WorldBounds,
} from './types'

// ─────────────────────────────────────────────────
// Tuning constants — practice-mode values (see header)
// ─────────────────────────────────────────────────

/** World 6000×6000 centred at the origin (practice: max(canvas*6, 6000)). */
const BOUNDS: WorldBounds = { minX: -3000, minY: -3000, maxX: 3000, maxY: 3000 }

/** Grid cell size — ≈2× a typical blob diameter. */
const GRID_CELL = 400

/**
 * Interest radius. The practice camera bottoms out at zoom 0.42, which on a
 * 1920×1080 canvas shows ~2620 world units from the centre to a corner — so
 * anything under that would pop in ON SCREEN. 2700 covers the widest
 * practice view with a little margin.
 */
const VIEW_RADIUS = 2700

/** Food: 1500 pellets of radius 8, each worth +0.5 blob radius (practice). */
const FOOD_COUNT = 1500
const FOOD_RADIUS = 8
const FOOD_GROWTH = 0.5
const FOOD_SCORE = 1

/** Size model. Practice grows the RADIUS directly and treats
 *  mass = r²/100 (display only); a cell under radius 5 is dead. */
const START_RADIUS = 15
const MIN_RADIUS = 5
/** Not in practice (which is unbounded) — a sanity ceiling so one blob can
 *  never outgrow the interest radius or the spatial grid. */
const MAX_RADIUS = 600

/** Movement (practice `updatePlayer`): per-60fps-frame acceleration and the
 *  per-frame velocity decay. Terminal speed = ACCEL × 0.9/0.1 = 9 × ACCEL. */
const ACCEL_NUM = 3.6 * 45 // v += (3.6 / √r) * 45
const VEL_DECAY_PER_FRAME = 0.9
/** Below this the client is asking us to coast (practice: dist ≤ 5 px). */
const INPUT_DEADZONE = 0.05

/** Boost (practice): ×1.65 acceleration, 5 seconds banked per kill. */
const BOOST_MULT = 1.65
const BOOST_SECONDS_PER_KILL = 5

/** Eat rules (practice player-vs-enemy). Applied symmetrically online, so
 *  neither player is on the bot side of the asymmetry. */
const EAT_RADIUS_RATIO = 1.1
const EAT_DIST_FACTOR = 0.3
const EAT_GAIN = 0.3
const EAT_SCORE = 20

/** Spawn safety: retry random spots that have a live blob this close
 *  (practice keeps AI ≥600 units from the player at spawn). */
const SAFE_SPAWN_DIST = 600
const SPAWN_ATTEMPTS = 12

/**
 * ZONE SPAWN — how far from the ring centre a player may be dropped, as a
 * fraction of the CURRENT ring radius.
 *
 * Practice spawns the player at exactly (0,0): the centre of the opening ring
 * (`gameEngine.ts` `startX`/`startY` = 0). A zone world that instead scattered
 * players across the whole 6000² box would drop somebody ~4200 units from the
 * centre, and the ring reaches them long before they can cross that distance —
 * verified live: an idle player died to the ring 7 s into a Blitz match and a
 * player steering straight for the centre still died at ~13 s. So zone worlds
 * spawn inside the ring; free play (difficulty 1, no zone) keeps the original
 * whole-box spawn, unchanged.
 */
const ZONE_SPAWN_RADIUS_FRACTION = 0.4

/** Food-delta hysteresis: a known pellet is only "removed" once it drifts
 *  past 110% of the view radius, so the boundary doesn't flip-flop. */
const FOOD_FORGET_RADIUS = VIEW_RADIUS * 1.1

// ─────────────────────────────────────────────────
// Safe zone — verbatim from practice `gameEngine.ts`
// ─────────────────────────────────────────────────

/** Practice: hypot(worldWidth/2, worldHeight/2) — the first ring covers the
 *  whole 6000² world including its corners. */
const MAX_ZONE_RADIUS = Math.hypot(
  (BOUNDS.maxX - BOUNDS.minX) / 2,
  (BOUNDS.maxY - BOUNDS.minY) / 2
)

/** Practice: `if (this.zoneRadius < 150) this.zoneRadius = 150`. */
const ZONE_MIN_RADIUS = 150

/** Practice: shrink rate 180 in Blitz, 120 otherwise. Only consumed by the
 *  no-target fallback path (a 10+ world always has a target), kept so the
 *  fallback behaves identically to practice if it is ever reached. */
const ZONE_SHRINK_RATE_BLITZ = 180
const ZONE_SHRINK_RATE_DEFAULT = 120

/** Practice `generateNextSafeZone`: the next ring is 30% of the current one
 *  in Blitz, 50% otherwise. */
const ZONE_SHRINK_FACTOR_BLITZ = 0.3
const ZONE_SHRINK_FACTOR_DEFAULT = 0.5

/** Practice: phase 1 lasts 20 s in every sector. */
const ZONE_PHASE1_DURATION = 20
/** Practice Blitz override: every phase after the first shrinks over 10 s. */
const ZONE_BLITZ_PHASE_DURATION = 10
/** Practice non-Blitz: `20 + (totalPlayTime / 60) * 10` — phases get longer
 *  the further into the match you are. */
const ZONE_PHASE_GROWTH_PER_MIN = 10

/**
 * Practice's stabilization (non-shrinking) window, keyed by difficulty:
 * `{1: 99999, 10: 20, 12: 8}` with a default of 30. The LMS codes (11/13)
 * are deliberately NOT keyed in practice, so they take the 30 s default —
 * that quirk is practice behaviour and is mirrored, not "fixed", here.
 */
const ZONE_STOP_DURATIONS: Record<number, number> = { 10: 20, 12: 8 }
const ZONE_STOP_DURATION_DEFAULT = 30

/** Practice Blitz: the last 3 s of a stable phase render a countdown. */
const ZONE_BLITZ_COUNTDOWN_S = 3

/** A zone circle. Field names match the practice engine's `safeZone` /
 *  `nextSafeZone` objects so the client can drop them straight in. */
interface ZoneCircle {
  x: number
  y: number
  radius: number
}

// ─────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────

interface Food {
  id: number
  x: number
  y: number
}

/** The cells-specific session: one circle, radius-driven (practice model). */
interface CellsSession extends BaseSession<CellsInput> {
  /** Seconds of boost banked (earned 5 at a time by eating players). */
  boostRemaining: number
  /** Whether boost was actually applied last step (for the HUD). */
  boosting: boolean
  /** Pellet ids this CLIENT currently knows about — the server-side half of
   *  the food-delta protocol. Cleared on despawn. */
  knownFood: Set<number>
}

/** Practice's display mass: `mass = (radius * radius) / 100`. */
const massFromRadius = (r: number): number => (r * r) / 100

// ─────────────────────────────────────────────────
// World
// ─────────────────────────────────────────────────

export class CellsWorld extends World<CellsInput, CellsSession> {
  /** Rebuilt every tick before collision resolution. */
  private readonly playerGrid = new SpatialGrid<CellsSession>(GRID_CELL)
  private readonly foodGrid = new SpatialGrid<Food>(GRID_CELL)

  /** id → pellet. Capped at FOOD_COUNT — respawned to cap, never beyond. */
  private readonly foods = new Map<number, Food>()
  private nextFoodId = 1

  // Reused query scratch arrays — cleared per use, never per-tick realloc.
  private readonly queryScratch: CellsSession[] = []
  private readonly foodScratch: Food[] = []

  // ── safe zone (practice `gameEngine.ts` field-for-field) ──
  // Which zone (if any) this world runs comes from the BASE class: it owns
  // `difficulty` (1 = free play, 10/11 Eclipse, 12/13 Blitz) plus the
  // `zoneEnabled` / `isBlitz` predicates the practice engine keys off.
  /** Live (red) ring — practice `zoneX` / `zoneY` / `zoneRadius`. */
  private zoneX = 0
  private zoneY = 0
  private zoneRadius = MAX_ZONE_RADIUS
  /** The ring reached at the end of the last shrink (practice `safeZone`). */
  private safeZone: ZoneCircle = { x: 0, y: 0, radius: MAX_ZONE_RADIUS }
  /** The ring being shrunk toward (practice `nextSafeZone`). */
  private nextSafeZone: ZoneCircle | null = null
  private zoneShrinkRate = ZONE_SHRINK_RATE_DEFAULT
  private zonePhase = 1
  private isZoneShrinking = false
  /** Seconds left in the current phase (practice `zonePhaseTimer`). */
  private zonePhaseTimer = ZONE_PHASE1_DURATION
  /** Seconds the zone holds still between shrinks (practice
   *  `zoneStopDuration`). */
  private readonly zoneStopDuration: number
  /** Length of the CURRENT shrink phase (practice `phaseActiveDuration`). */
  private phaseActiveDuration = ZONE_PHASE1_DURATION
  /** Seconds simulated since the match started (drives practice's
   *  "phases get longer as the match ages" rule). */
  private totalPlayTime = 0
  /** Blitz only: seconds until the next shrink starts, during the last 3 s
   *  of a stable phase (practice `countdownTimer`); null otherwise. */
  private countdownTimer: number | null = null

  constructor(options: WorldOptions) {
    super('cells', BOUNDS, VIEW_RADIUS, options)
    // Seed the pellet field once; the tick keeps it topped up forever.
    while (this.foods.size < FOOD_COUNT) this.spawnFood()

    // Zone setup — practice `GameEngine` constructor, in the same order.
    this.zoneShrinkRate = this.isBlitz ? ZONE_SHRINK_RATE_BLITZ : ZONE_SHRINK_RATE_DEFAULT
    this.zoneStopDuration =
      ZONE_STOP_DURATIONS[this.difficulty] ?? ZONE_STOP_DURATION_DEFAULT
    if (this.zoneEnabled) {
      // Practice starts phase 1 already shrinking, onto a target generated
      // up front so the client can show where to run from the first frame.
      this.nextSafeZone = this.generateNextSafeZone(this.safeZone)
      this.isZoneShrinking = true
      this.phaseActiveDuration = ZONE_PHASE1_DURATION
      this.zonePhaseTimer = ZONE_PHASE1_DURATION
    }
  }

  /**
   * Practice `generateNextSafeZone`: a ring 30% (Blitz) / 50% of the current
   * radius, at a random centre that keeps it entirely INSIDE the current one.
   */
  private generateNextSafeZone(current: ZoneCircle): ZoneCircle {
    const shrinkFactor = this.isBlitz ? ZONE_SHRINK_FACTOR_BLITZ : ZONE_SHRINK_FACTOR_DEFAULT
    const nextRadius = current.radius * shrinkFactor
    const maxOffset = current.radius - nextRadius
    const angle = Math.random() * Math.PI * 2
    const distance = Math.random() * maxOffset
    return {
      x: current.x + Math.cos(angle) * distance,
      y: current.y + Math.sin(angle) * distance,
      radius: nextRadius,
    }
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
      boostRemaining: 0,
      boosting: false,
      knownFood: new Set(),
    }
  }

  /** Fresh life: practice's starting radius at a random spot clear of
   *  other blobs, at rest. */
  protected spawn(session: CellsSession): void {
    session.r = START_RADIUS
    session.vx = 0
    session.vy = 0
    session.boostRemaining = 0
    session.boosting = false
    // Random safe spot: retry a few times, accept the last try regardless
    // (a busy world beats an infinite loop; worst case is a risky spawn).
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const spot = this.spawnPoint()
      session.x = spot.x
      session.y = spot.y
      if (this.isSpawnSafe(session)) break
    }
  }

  /**
   * A candidate spawn spot. Free play (no zone) keeps practice's whole-box
   * scatter; a zone world spawns INSIDE the live ring, near its centre, the
   * way practice starts the player dead-centre of the opening ring. Uniform
   * over the disc (sqrt of the random radius) so spawns don't clump at the
   * exact middle, then clamped back into the world box because a ring is
   * allowed to hang off the edge of the map (practice does not clamp it).
   */
  private spawnPoint(): { x: number; y: number } {
    if (!this.zoneEnabled) {
      return {
        x: BOUNDS.minX + 100 + Math.random() * (BOUNDS.maxX - BOUNDS.minX - 200),
        y: BOUNDS.minY + 100 + Math.random() * (BOUNDS.maxY - BOUNDS.minY - 200),
      }
    }
    const angle = Math.random() * Math.PI * 2
    const dist = Math.sqrt(Math.random()) * this.zoneRadius * ZONE_SPAWN_RADIUS_FRACTION
    const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
    return {
      x: clamp(this.zoneX + Math.cos(angle) * dist, BOUNDS.minX + 100, BOUNDS.maxX - 100),
      y: clamp(this.zoneY + Math.sin(angle) * dist, BOUNDS.minY + 100, BOUNDS.maxY - 100),
    }
  }

  /** No live blob within SAFE_SPAWN_DIST of the candidate spot. */
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
    // 1) Movement, integrated at the practice frame rate (3 × 1/60 s).
    for (let i = 0; i < SUBSTEPS_PER_TICK; i++) this.moveFrame(SUBSTEP_DT)

    // 2) Rebuild grids AFTER movement, BEFORE collisions.
    this.refreshGrids()

    // 3) Eat food: pellet centre inside the blob → +0.5 radius (practice).
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
        s.r = Math.min(MAX_RADIUS, s.r + FOOD_GROWTH)
        s.score += FOOD_SCORE
      }
    }

    // 4) Eat players: practice's rule, applied symmetrically.
    // Each pair is handled once from the EATER's perspective; the victim
    // flips alive=false immediately (inside resolveKill) so it can't be
    // eaten twice in one tick.
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
        if (dist >= s.r - other.r * EAT_DIST_FACTOR) continue // not covered
        // Absorb (practice: eater.radius += victim.radius * 0.3).
        s.r = Math.min(MAX_RADIUS, s.r + other.r * EAT_GAIN)
        s.score += EAT_SCORE
        // Practice rewards a kill with 5 stackable seconds of boost.
        s.boostRemaining += BOOST_SECONDS_PER_KILL
        this.resolveKill(s, other)
      }
    }

    // 5) Respawn pellets up to the cap (a few per tick at most).
    while (this.foods.size < FOOD_COUNT) this.spawnFood()

    // 6) Zone LAST, exactly like practice's update() — the ring advances
    // against final positions, and anyone left outside it dies.
    this.updateZone(dt)

    void now // lifecycle timing is handled by the base class
  }

  /**
   * ONE zone step — practice `gameEngine.ts` `update()`, tail section, in
   * the same order: age the phase timer, flip the phase machine, refresh the
   * Blitz countdown, move/shrink the ring, clamp it, then kill whoever is
   * outside it.
   *
   * Practice runs this per animation frame; the maths is pure dt so running
   * it once per 20 Hz tick produces the same ring at the same wall-clock
   * second. The interpolation in particular is step-size independent: the
   * per-step fraction `dt / remaining` telescopes to "arrive exactly when the
   * phase timer hits zero" for any dt.
   *
   * It is only ever called while the world is RUNNING (the base class does
   * not step a world during the lobby countdown), so the zone starts moving
   * the instant the match starts and not a second earlier.
   */
  private updateZone(dt: number): void {
    if (!this.zoneEnabled) return

    // ── phase machine ──
    this.totalPlayTime += dt
    this.zonePhaseTimer -= dt
    if (this.zonePhaseTimer <= 0) {
      if (this.isZoneShrinking) {
        // Shrink finished → stabilize on the ring we just reached.
        this.isZoneShrinking = false
        this.zonePhaseTimer = this.zoneStopDuration
        this.countdownTimer = null
        this.safeZone = this.nextSafeZone
          ? { ...this.nextSafeZone }
          : { x: this.zoneX, y: this.zoneY, radius: this.zoneRadius }
        // Pre-generate the next target so it is visible while stable.
        this.nextSafeZone = this.generateNextSafeZone(this.safeZone)
      } else {
        // Stable window over → start the next shrink.
        this.zonePhase++
        this.isZoneShrinking = true
        // Practice: later phases take longer... unless Blitz, which pins
        // every phase after the first to a flat 10 s.
        this.phaseActiveDuration =
          ZONE_PHASE1_DURATION + (this.totalPlayTime / 60) * ZONE_PHASE_GROWTH_PER_MIN
        if (this.isBlitz) {
          this.phaseActiveDuration =
            this.zonePhase > 1 ? ZONE_BLITZ_PHASE_DURATION : ZONE_PHASE1_DURATION
        }
        this.zonePhaseTimer = this.phaseActiveDuration
        if (!this.nextSafeZone) this.nextSafeZone = this.generateNextSafeZone(this.safeZone)
      }
    }

    // ── Blitz: 3 s countdown before a shrink starts ──
    this.countdownTimer =
      !this.isZoneShrinking && this.isBlitz && this.zonePhaseTimer <= ZONE_BLITZ_COUNTDOWN_S
        ? this.zonePhaseTimer
        : null

    // ── move / shrink ──
    if (this.isZoneShrinking) {
      if (this.nextSafeZone) {
        // Reach the target exactly as the phase timer runs out.
        const totalRemaining = this.zonePhaseTimer + dt
        const stepFraction = dt / totalRemaining
        this.zoneX += (this.nextSafeZone.x - this.zoneX) * stepFraction
        this.zoneY += (this.nextSafeZone.y - this.zoneY) * stepFraction
        this.zoneRadius += (this.nextSafeZone.radius - this.zoneRadius) * stepFraction
      } else {
        // Practice's target-less fallback: speed steps up 0.25 per phase.
        this.zoneRadius -= this.zoneShrinkRate * (0.25 * this.zonePhase) * dt
      }
    }
    if (this.zoneRadius < ZONE_MIN_RADIUS) this.zoneRadius = ZONE_MIN_RADIUS

    // ── out of the ring = instant death (practice, every zone mode) ──
    // Snapshot the sessions: an environment kill can mutate the map (it
    // despawns in the permanent world), and the loop must survive that.
    for (const s of [...this.sessions.values()]) {
      if (!s.alive) continue
      const dx = s.x - this.zoneX
      const dy = s.y - this.zoneY
      // No grace, no chip damage: practice kills the instant you are outside.
      if (dx * dx + dy * dy > this.zoneRadius * this.zoneRadius) {
        this.resolveEnvironmentKill(s, 'zone')
      }
    }
  }

  /**
   * ONE practice frame of movement (1/60 s). Mirrors `updatePlayer` in the
   * practice engine exactly: accelerate toward the input direction, decay
   * the velocity, then integrate the position.
   */
  private moveFrame(dt: number): void {
    for (const s of this.sessions.values()) {
      if (!s.alive) continue

      const input = s.input
      let boosting = false
      if (input) {
        const len = Math.hypot(input.dx, input.dy)
        if (len > INPUT_DEADZONE) {
          // Direction only — a diagonal must not be √2 faster.
          const nx = input.dx / len
          const ny = input.dy / len
          boosting = input.boost === true && s.boostRemaining > 0
          if (boosting) s.boostRemaining = Math.max(0, s.boostRemaining - dt)
          const accel =
            (ACCEL_NUM / Math.sqrt(s.r)) *
            (boosting ? BOOST_MULT : 1) *
            this.moveScale(s) // cash-out hold hinders movement (free play)
          s.vx += nx * accel
          s.vy += ny * accel
        }
      }
      s.boosting = boosting

      // Practice decays velocity by 0.9 every 60 fps frame.
      s.vx *= VEL_DECAY_PER_FRAME
      s.vy *= VEL_DECAY_PER_FRAME
      s.x += s.vx * dt
      s.y += s.vy * dt

      // Practice bounces off the world edge at half speed.
      if (s.x < BOUNDS.minX) {
        s.x = BOUNDS.minX
        s.vx *= -0.5
      } else if (s.x > BOUNDS.maxX) {
        s.x = BOUNDS.maxX
        s.vx *= -0.5
      }
      if (s.y < BOUNDS.minY) {
        s.y = BOUNDS.minY
        s.vy *= -0.5
      } else if (s.y > BOUNDS.maxY) {
        s.y = BOUNDS.maxY
        s.vy *= -0.5
      }

      if (s.r < MIN_RADIUS) s.r = MIN_RADIUS
    }
  }

  /** Blob + pellet buckets at their current positions (also used by the
   *  countdown broadcast, which must not simulate anything). */
  protected refreshGrids(): void {
    this.playerGrid.clear()
    this.foodGrid.clear()
    for (const s of this.sessions.values()) {
      if (s.alive) this.playerGrid.insert(s, s.x, s.y, s.r)
    }
    for (const f of this.foods.values()) {
      this.foodGrid.insert(f, f.x, f.y, FOOD_RADIUS)
    }
  }

  private spawnFood(): void {
    const id = this.nextFoodId++
    this.foods.set(id, {
      id,
      x: BOUNDS.minX + Math.random() * (BOUNDS.maxX - BOUNDS.minX),
      y: BOUNDS.minY + Math.random() * (BOUNDS.maxY - BOUNDS.minY),
    })
  }

  // ── interest-managed state ────────────────────

  protected buildState(session: CellsSession, now: number): Record<string, unknown> {
    // Visible players: grid superset → precise view-circle filter.
    this.queryScratch.length = 0
    const candidates = this.playerGrid.query(
      session.x,
      session.y,
      this.viewRadius,
      this.queryScratch
    )
    const players: Array<Record<string, unknown>> = []
    for (const other of candidates) {
      if (other === session || !other.alive) continue
      const dx = other.x - session.x
      const dy = other.y - session.y
      if (Math.hypot(dx, dy) - other.r > this.viewRadius) continue
      players.push({
        id: other.id, // opaque session id — wallets never leave the server
        name: other.name,
        x: Math.round(other.x),
        y: Math.round(other.y),
        // Velocity lets the client extrapolate between 20 Hz frames instead
        // of snapping to each snapshot (the jitter fix).
        vx: Math.round(other.vx),
        vy: Math.round(other.vy),
        r: Math.round(other.r),
        mass: Math.round(massFromRadius(other.r)),
        kills: other.kills,
        score: other.score,
        boosting: other.boosting,
      })
    }

    // Food DELTAS against this client's known set: `added` are newly visible
    // pellets, `removed` are pellets that were eaten or left the view.
    const added: Food[] = []
    const removed: number[] = []
    this.foodScratch.length = 0
    const visibleFood = this.foodGrid.query(
      session.x,
      session.y,
      this.viewRadius,
      this.foodScratch
    )
    for (const f of visibleFood) {
      if (!this.foods.has(f.id) || session.knownFood.has(f.id)) continue
      const dx = f.x - session.x
      const dy = f.y - session.y
      if (dx * dx + dy * dy > this.viewRadius * this.viewRadius) continue
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
        vx: session.vx,
        vy: session.vy,
        r: session.r,
        mass: Math.round(massFromRadius(session.r)),
        score: session.score,
        kills: session.kills,
        pot: session.pot,
        alive: session.alive,
        eliminated: session.eliminated,
        place: session.place,
        boosting: session.boosting,
        boostRemaining: Number(session.boostRemaining.toFixed(2)),
        respawnIn: session.respawnAt ? Math.max(0, session.respawnAt - now) : 0,
        cashingOut: session.cashout !== 'none',
      },
      players,
      food: { added, removed },
      leaderboard: this.leaderboard,
      zone: this.zoneState(),
    }
  }

  /**
   * The authoritative zone, shipped with every snapshot so clients RENDER it
   * instead of simulating a second copy. `null` = this world has no zone
   * (free play), which is the client's cue to draw nothing.
   *
   * Field names mirror the practice engine so the client can assign them
   * straight across:
   *   x / y / radius   → engine.zoneX / zoneY / zoneRadius  (the red ring)
   *   safe             → engine.safeZone
   *   next             → engine.nextSafeZone (null only in the fallback path)
   *   shrinking        → engine.isZoneShrinking
   *   phase            → engine.zonePhase
   *   phaseTimer       → engine.zonePhaseTimer (seconds left in this phase)
   *   countdown        → engine.countdownTimer (Blitz 3 s warning, else null)
   *   difficulty       → the practice difficulty code this match is running
   */
  private zoneState(): Record<string, unknown> | null {
    if (!this.zoneEnabled) return null
    return {
      x: Math.round(this.zoneX),
      y: Math.round(this.zoneY),
      radius: Math.round(this.zoneRadius),
      safe: {
        x: Math.round(this.safeZone.x),
        y: Math.round(this.safeZone.y),
        radius: Math.round(this.safeZone.radius),
      },
      next: this.nextSafeZone
        ? {
            x: Math.round(this.nextSafeZone.x),
            y: Math.round(this.nextSafeZone.y),
            radius: Math.round(this.nextSafeZone.radius),
          }
        : null,
      shrinking: this.isZoneShrinking,
      phase: this.zonePhase,
      phaseTimer: Number(Math.max(0, this.zonePhaseTimer).toFixed(2)),
      countdown:
        this.countdownTimer === null
          ? null
          : Number(Math.max(0, this.countdownTimer).toFixed(2)),
      difficulty: this.difficulty,
    }
  }
}
