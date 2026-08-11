/**
 * FREE PLAY — shared types, constants and zod schemas
 * ===================================================
 * Everything the permanent-world modules (world.ts, cellsWorld.ts,
 * asteroidsWorld.ts, index.ts) agree on lives here so no two files can
 * drift on a constant or a payload shape.
 *
 * Design contract: "Free play (permanent servers)" section +
 * `permanentSever, regions, atomic money patterns .md` §2-§4, §6-§7.
 *
 * SECURITY INVARIANTS (repeated because they are the whole point):
 * - Clients send DIRECTIONS/FLAGS only, never positions (money doc §2).
 * - Every client payload is zod-`safeParse`d; invalid payloads are
 *   silently ignored (global rule from the handoff).
 * - `wallet` NEVER leaves the server — clients see the opaque per-session
 *   `id` (a random UUID) instead.
 */

import { z } from 'zod'
import type { Socket } from 'socket.io'

// ─────────────────────────────────────────────────
// Games
// ─────────────────────────────────────────────────

/** The two permanent-world games. Tuple so z.enum can consume it. */
export const FREEPLAY_GAMES = ['cells', 'asteroids'] as const
export type FreeplayGame = (typeof FREEPLAY_GAMES)[number]

// ─────────────────────────────────────────────────
// Timing / world constants (design contract values)
// ─────────────────────────────────────────────────

/** 20 Hz authoritative tick — slither.io territory (money doc §2). */
export const TICK_RATE = 20
export const TICK_MS = 1000 / TICK_RATE

/** Interest-management radius: a player only receives entities whose
 *  circle intersects this view circle around them (money doc §3). */
export const VIEW_RADIUS = 1500

/** Disconnect grace window: the body stays in-world and KILLABLE (so a
 *  disconnect can't protect a fat pot), inputs are zeroed; a reconnect
 *  inside the window resumes, a timeout auto-cashes-out (doc §4). */
export const DISCONNECT_GRACE_MS = 60_000

/** Server-enforced cash-out hold. The client hold UI is cosmetic — the
 *  world loop is what decides the 3 seconds actually elapsed. */
export const CASHOUT_HOLD_MS = 3_000

/** Movement penalty while holding cash-out: holding hinders movement
 *  ("that is the intended risk", doc §4). Cells scales speed by this;
 *  asteroids scales TURN RATE by it (the ship auto-drives). */
export const CASHOUT_HOLD_PENALTY = 0.5

/** Delay between a player-kill death and the respawn (design contract). */
export const RESPAWN_DELAY_MS = 2_500

/** Doc §5: cap each world at ~150-200 concurrent players. We refuse joins
 *  past this with `freeplay:error { code:'world_full' }`. */
export const MAX_PLAYERS_PER_WORLD = 200

/** Top-N pot leaderboard included in every state broadcast. */
export const LEADERBOARD_SIZE = 5

// ─────────────────────────────────────────────────
// Zod schemas — C→S payloads
// ─────────────────────────────────────────────────

/** C→S `freeplay:join { game }`. Region is NOT a payload field — this
 *  server instance IS a region (config.REGION), per the money doc §5. */
export const joinSchema = z.object({
  game: z.enum(FREEPLAY_GAMES),
})
export type JoinPayload = z.infer<typeof joinSchema>

/**
 * C→S `freeplay:input` for cells: a direction vector plus a boost flag.
 * Components are bounded to [-1, 1]; the world ADDITIONALLY normalizes
 * the vector magnitude to ≤ 1 (a diagonal {1,1} must not be √2 faster —
 * "clamp speed server-side", money doc §2).
 */
export const cellsInputSchema = z.object({
  dx: z.number().min(-1).max(1),
  dy: z.number().min(-1).max(1),
  boost: z.boolean().optional(),
})
export type CellsInput = z.infer<typeof cellsInputSchema>

/**
 * C→S `freeplay:input` for asteroids: turn direction and trigger flags.
 * The ship auto-drives — there is deliberately NO position, NO speed and
 * NO angle in the payload.
 */
export const asteroidsInputSchema = z.object({
  turn: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  shoot: z.boolean().optional(),
  reload: z.boolean().optional(),
})
export type AsteroidsInput = z.infer<typeof asteroidsInputSchema>

/**
 * `freeplay:cashout_start` / `freeplay:cashout_cancel` / `freeplay:leave`
 * carry no payload. We still validate: undefined/null/{} are accepted,
 * anything else is silently ignored (a malformed emitter gets nothing).
 */
export const noPayloadSchema = z.union([
  z.undefined(),
  z.null(),
  z.object({}).strip(),
])

// ─────────────────────────────────────────────────
// World geometry
// ─────────────────────────────────────────────────

/** Axis-aligned world bounds. Cells is origin-centered (±3000); asteroids
 *  is [0, 8000] — both expressible here, and `freeplay:joined` ships the
 *  bounds so the client never has to guess the coordinate convention. */
export interface WorldBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// ─────────────────────────────────────────────────
// Per-player session state (in-memory — render cache only for money)
// ─────────────────────────────────────────────────

/**
 * The world-agnostic slice of a player session. Game worlds extend this
 * (cells adds mass, asteroids adds angle/health/ammo/...).
 *
 * MONEY NOTE: `pot` and `kills` here are a RENDER CACHE. The database
 * (matchPlayers via wagerService) is the only source of truth; these
 * fields are refreshed from transaction RESULTS after every settlement
 * and reconciled from the DB in the background (money doc §6 principle).
 */
export interface BaseSession<TInput> {
  /** Opaque public id (crypto.randomUUID). This — never the wallet — is
   *  what other clients see. One id per session (a rejoin after cash-out
   *  gets a fresh one; a grace-window resume keeps it). */
  id: string
  /** Trusted identity from the socket handshake JWT. SERVER-ONLY. */
  wallet: string
  /** Registered username (socket.data.username) — the display name. */
  name: string
  /** Live socket, or null while in the disconnect grace window. */
  socket: Socket | null

  // — simulation state (server-authoritative, clients never write these) —
  x: number
  y: number
  /** Collision/interest radius. Cells derives it from mass; asteroids
   *  uses a constant ship radius. Lives on the base so the SpatialGrid
   *  and view queries can treat every session uniformly. */
  r: number
  /** Alive = simulated + killable. Dead sessions await respawn (pvp kill)
   *  or despawn (environment kill / cash-out). */
  alive: boolean
  /** When a pvp-killed player comes back (Date.now() ms); null = no
   *  pending respawn (alive, or eliminated-for-good). */
  respawnAt: number | null
  /** Display name of the last killer — for the respawn payload. */
  killedBy: string | null

  // — money render cache (see MONEY NOTE) —
  pot: number
  kills: number

  // — cash-out state machine: none → holding → processing → (despawn) —
  cashout: 'none' | 'holding' | 'processing'
  holdStartAt: number | null

  // — disconnect grace —
  disconnectedAt: number | null

  /** Last-write-wins input slot (the "queue" of depth 1). Zeroed on
   *  disconnect so a grace-window body coasts instead of acting. */
  input: TInput | null

  joinedAt: number
}

// ─────────────────────────────────────────────────
// S→C payload shapes (documentation-grade types — the worlds build these)
// ─────────────────────────────────────────────────

export interface LeaderboardEntry {
  name: string
  pot: number
}

/** S→C `freeplay:joined` — the session handshake. */
export interface JoinedPayload {
  matchId: string
  /** The opaque session id (NOT the wallet). */
  playerId: string
  entryFee: number
  world: {
    w: number
    h: number
    game: FreeplayGame
    bounds: WorldBounds
  }
  /** Server tick rate so the client can pace its input emits. */
  tick: number
}

// ─────────────────────────────────────────────────
// Errors — `freeplay:error { code, message }`
// ─────────────────────────────────────────────────

/**
 * Machine-readable error codes. The design contract names `no_db` and
 * `already_active` explicitly; the rest cover the remaining refusal paths
 * so the client never has to parse a human message.
 */
export type FreeplayErrorCode =
  | 'no_db' //          free play refuses to run without a ledger (contract)
  | 'already_active' // wallet already holds an active session (Pattern 5)
  | 'world_full' //     MAX_PLAYERS_PER_WORLD reached (money doc §5 cap)
  | 'bad_payload' //    freeplay:join payload failed zod validation
  | 'join_failed' //    transient join refusal (mid-join collision, shutdown)
  | 'cashout_failed' // cash-out claim lost (killed same instant) or DB error

/** One shared shape for every refusal so no emitter drifts on field names. */
export function emitFreeplayError(
  socket: Socket,
  code: FreeplayErrorCode,
  message: string
): void {
  socket.emit('freeplay:error', { code, message })
}
