/**
 * FREE PLAY / LOBBY WORLDS — shared types, constants and zod schemas
 * ==================================================================
 * Everything the world modules (world.ts, cellsWorld.ts, asteroidsWorld.ts,
 * lobby.ts, index.ts) agree on lives here so no two files can drift on a
 * constant or a payload shape.
 *
 * THREE WORLD MODES (contract "Neon Cells + Neon Asteroids"):
 *   free_play — the ONE permanent world per game. Join anytime, no queue.
 *               It is NOT queueable and is no longer reachable from the
 *               online lobby — practice keeps it, the code stays here.
 *   slayer    — lobby/queue mode. Match-scoped world, kill-count scoring,
 *               NO WINNER (everybody scores points for their kills).
 *   lms       — lobby/queue mode. Match-scoped world, last man standing.
 * slayer/lms reuse the exact same simulation as free play; only the
 * lifecycle (waiting → running → ended) and the death rule differ.
 *
 * TWO SECTORS × TWO MODES (the online 2×2):
 *   eclipse/slayer  eclipse/lms  blitz/slayer  blitz/lms
 * Sector+mode are encoded as ONE practice DIFFICULTY CODE (10/11/12/13),
 * exactly the numbers the practice difficulty selectors already use, so the
 * server sim and the client renderer run identical zone rules.
 *
 * SECURITY INVARIANTS (repeated because they are the whole point):
 * - Clients send DIRECTIONS/FLAGS only, never positions.
 * - Every client payload is zod-`safeParse`d; invalid payloads are
 *   silently ignored (global rule from the handoff).
 * - `wallet` NEVER leaves the server — clients see the opaque per-session
 *   `id` (a random UUID) instead.
 *
 * NO MONEY THIS PASS (contract "NO WAGER / NO MONEY"): pot bookkeeping is
 * best-effort only. A missing database, a failed pot call or an
 * already-active ledger row must NEVER stop anybody from playing.
 */

import { z } from 'zod'
import type { Socket } from 'socket.io'

// ─────────────────────────────────────────────────
// Games + modes
// ─────────────────────────────────────────────────

/** The two world games. Tuple so z.enum can consume it. */
export const FREEPLAY_GAMES = ['cells', 'asteroids'] as const
export type FreeplayGame = (typeof FREEPLAY_GAMES)[number]

/** The three modes the practice lobby offers — all three are honored. */
export const FREEPLAY_MODES = ['free_play', 'slayer', 'lms'] as const
export type FreeplayMode = (typeof FREEPLAY_MODES)[number]

/** The queue/lobby modes (everything except the permanent world). */
export const LOBBY_MODES = ['slayer', 'lms'] as const
export type LobbyMode = (typeof LOBBY_MODES)[number]

export const isLobbyMode = (mode: FreeplayMode): mode is LobbyMode =>
  mode === 'slayer' || mode === 'lms'

// ─────────────────────────────────────────────────
// Sectors + practice difficulty codes
// ─────────────────────────────────────────────────

/**
 * The two ONLINE sectors — the same two the practice difficulty selectors
 * offer (`free` / INFINITE is deliberately absent: free play is not a
 * queueable sector, it is the permanent drop-in world).
 */
export const FREEPLAY_SECTORS = ['eclipse', 'blitz'] as const
export type FreeplaySector = (typeof FREEPLAY_SECTORS)[number]

/**
 * PRACTICE DIFFICULTY CODES — the single source of truth for "which zone
 * rules run". Mirrors `Cells/CellsDifficultySelector.tsx` and
 * `Asteroids/AsteroidsDifficultySelector.tsx` verbatim:
 *
 *   free    → 1   INFINITE, no zone          (permanent world / practice)
 *   eclipse → 10 SLAYER  · 11 LAST MAN STANDING
 *   blitz   → 12 SLAYER  · 13 LAST MAN STANDING
 *
 * The client sims key off these numbers directly (cells `gameEngine.ts`:
 * `difficulty >= 10` enables safe zones, `12|13` = Blitz shrink rate;
 * asteroids `AsteroidsCore.tsx`: `11|13` shrink faster, `12|13` Blitz
 * timings), so online MUST use the same numbers to behave like practice.
 */
export const SECTOR_MODE_DIFFICULTY: Record<
  FreeplaySector,
  Record<LobbyMode, number>
> = {
  eclipse: { slayer: 10, lms: 11 },
  blitz: { slayer: 12, lms: 13 },
}

/** Difficulty of the permanent free-play world / practice INFINITE: no zone. */
export const FREE_PLAY_DIFFICULTY = 1

/** (sector, mode) → the practice difficulty code. Derived SERVER-SIDE only —
 *  a client never gets to pick the number. */
export function difficultyFor(sector: FreeplaySector, mode: LobbyMode): number {
  return SECTOR_MODE_DIFFICULTY[sector][mode]
}

/** Zones exist from 10 up (practice: `difficulty >= 10`). */
export const hasZone = (difficulty: number): boolean => difficulty >= 10

/** Blitz timings (practice: difficulty 12 or 13). */
export const isBlitzDifficulty = (difficulty: number): boolean =>
  difficulty === 12 || difficulty === 13

/** The faster-shrink branch (practice: difficulty 11 or 13 — the LMS codes). */
export const isFastShrinkDifficulty = (difficulty: number): boolean =>
  difficulty === 11 || difficulty === 13

/**
 * THE QUEUE KEY. All FOUR sector×mode combinations must be distinct queues,
 * otherwise an Eclipse Slayer player could be matched into a Blitz LMS game.
 * Wire format (also what `queue:status.mode` carries): `eclipse:slayer`,
 * `eclipse:lms`, `blitz:slayer`, `blitz:lms`.
 */
export function queueModeKey(sector: FreeplaySector, mode: LobbyMode): string {
  return `${sector}:${mode}`
}

// ─────────────────────────────────────────────────
// Timing / world constants
// ─────────────────────────────────────────────────

/** 20 Hz authoritative tick — slither.io territory. */
export const TICK_RATE = 20
export const TICK_MS = 1000 / TICK_RATE

/**
 * The practice engines integrate per animation frame at 60 fps. The server
 * therefore runs its movement/collision maths in fixed 1/60 s SUB-STEPS
 * inside every 20 Hz tick (3 sub-steps), so a constant lifted from practice
 * produces the *same* motion here instead of a re-tuned approximation.
 */
export const PRACTICE_FPS = 60
export const SUBSTEPS_PER_TICK = Math.round((TICK_MS / 1000) * PRACTICE_FPS) // 3
export const SUBSTEP_DT = 1 / PRACTICE_FPS

/**
 * Default interest-management radius. Each world overrides it with the
 * radius its practice camera can actually show at maximum zoom-out, so
 * entities never pop in inside the visible area.
 */
export const VIEW_RADIUS = 1500

/** Disconnect grace window for the PERMANENT world: the body stays in-world
 *  and killable, inputs are zeroed; a reconnect inside the window resumes. */
export const DISCONNECT_GRACE_MS = 60_000

/** Server-enforced cash-out hold (permanent world only — lobby matches have
 *  no money and no cash-out). The client hold UI is cosmetic. */
export const CASHOUT_HOLD_MS = 3_000

/** Movement penalty while holding cash-out (permanent world only). */
export const CASHOUT_HOLD_PENALTY = 0.5

/** Delay between a player-kill death and the respawn (permanent world). */
export const RESPAWN_DELAY_MS = 2_500

/** Cap for the permanent world. */
export const MAX_PLAYERS_PER_WORLD = 200

/** Top-N leaderboard included in every state broadcast. */
export const LEADERBOARD_SIZE = 5

// ── lobby (slayer / lms) ───────────────────────

/** Contract: minimum 2 players (so it is testable), cap 20. */
export const LOBBY_MIN_PLAYERS = 2
export const LOBBY_MAX_PLAYERS = 20

/** Countdown between "enough players" and the first simulated tick, so
 *  every client has time to mount its canvas before anyone can be killed. */
export const MATCH_COUNTDOWN_MS = 3_000

/** How long an ENDED lobby world stays alive before it is torn down — long
 *  enough for a late/rejoining socket to still receive the result. */
export const MATCH_END_LINGER_MS = 15_000

/** Hard ceiling on a lobby match so a stalemate can never pin a world
 *  forever (nobody can find anybody in an 8000² world for 15 minutes). */
export const MATCH_MAX_DURATION_MS = 15 * 60_000

// ─────────────────────────────────────────────────
// Zod schemas — C→S payloads
// ─────────────────────────────────────────────────

/**
 * C→S `freeplay:join { game, mode?, sector? }`. Region is NOT a payload
 * field — this server instance IS a region. `mode` is optional so the
 * shipped client (which only sends `{ game }`) keeps landing in the
 * permanent free world. `sector` is only meaningful for a lobby mode, and
 * index.ts REQUIRES it there (a queueable mode without a sector cannot be
 * resolved to a difficulty code, so it is refused rather than guessed).
 */
export const joinSchema = z.object({
  game: z.enum(FREEPLAY_GAMES),
  mode: z.enum(FREEPLAY_MODES).default('free_play'),
  sector: z.enum(FREEPLAY_SECTORS).optional(),
})
export type JoinPayload = z.infer<typeof joinSchema>

/**
 * C→S `freeplay:find { game, mode, sector }` — enter one of the FOUR
 * sector×mode queues.
 *
 * `mode` is `z.enum(LOBBY_MODES)`, so `free_play` is REJECTED on this path
 * by construction: free play is a permanent drop-in world, never a queue.
 * `sector` is REQUIRED — it is half of the difficulty code.
 */
export const findSchema = z.object({
  game: z.enum(FREEPLAY_GAMES),
  mode: z.enum(LOBBY_MODES),
  sector: z.enum(FREEPLAY_SECTORS),
})
export type FindPayload = z.infer<typeof findSchema>

/** C→S `freeplay:cancel { game, mode?, sector? }` — leave the queue (cancel
 *  button, unmount, view change). Anything short of a full (mode, sector)
 *  pair leaves EVERY queue of that game, which is always safe: a wallet only
 *  ever holds one slot per game. */
export const cancelSchema = z.object({
  game: z.enum(FREEPLAY_GAMES),
  mode: z.enum(LOBBY_MODES).optional(),
  sector: z.enum(FREEPLAY_SECTORS).optional(),
})
export type CancelPayload = z.infer<typeof cancelSchema>

/**
 * C→S `freeplay:input` for cells: a direction vector plus a boost flag.
 * Components are bounded to [-1, 1]; the world ADDITIONALLY normalizes the
 * vector magnitude to ≤ 1 (a diagonal {1,1} must not be √2 faster).
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
// Per-player session state
// ─────────────────────────────────────────────────

/**
 * The world-agnostic slice of a player session. Game worlds extend this
 * (cells adds radius growth + boost, asteroids adds angle/hp/ammo/...).
 *
 * MONEY NOTE: `pot` is a RENDER CACHE and, this pass, purely cosmetic —
 * lobby matches never touch the ledger at all and free play treats every
 * pot call as best-effort. `kills` is authoritative in-memory for scoring.
 */
export interface BaseSession<TInput> {
  /** Opaque public id (crypto.randomUUID). This — never the wallet — is
   *  what other clients see. */
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
  /** Velocity, in world units per SECOND. Broadcast with the snapshot so a
   *  client can predict/extrapolate between 20 Hz frames instead of
   *  snapping (the "jitter" fix from the contract). */
  vx: number
  vy: number
  /** Collision/interest radius. */
  r: number
  /** Alive = simulated + killable. */
  alive: boolean
  /** When a pvp-killed player comes back (Date.now() ms); null = no pending
   *  respawn. Lobby modes never set it — death there is elimination. */
  respawnAt: number | null
  /** Display name of the last killer — for the respawn payload. */
  killedBy: string | null

  // — lobby scoring/lifecycle —
  /** Lobby modes: knocked out for good (no respawn). */
  eliminated: boolean
  /** Final placement once eliminated (1 = winner); null while in play. */
  place: number | null
  /** Monotonic score (cells: food+kills, asteroids: rocks+kills). */
  score: number

  // — money render cache (best-effort, never a gate) —
  pot: number
  kills: number
  /** True when a matchPlayers row actually backs this session. False = the
   *  DB was absent/refused; play continues, money bookkeeping is skipped. */
  ledger: boolean

  // — cash-out state machine (permanent world only) —
  cashout: 'none' | 'holding' | 'processing'
  holdStartAt: number | null

  // — disconnect grace —
  disconnectedAt: number | null

  /** Last-write-wins input slot (the "queue" of depth 1). */
  input: TInput | null

  joinedAt: number
}

// ─────────────────────────────────────────────────
// S→C payload shapes
// ─────────────────────────────────────────────────

export interface LeaderboardEntry {
  name: string
  /** Kept for the permanent world's pot column (0 when there is no ledger). */
  pot: number
  /** Mode-aware scoreboard values the lobby HUD drives off. */
  kills: number
  score: number
}

/** Lifecycle of a world. The permanent free-play world is always 'running'. */
export type WorldStatus = 'waiting' | 'running' | 'ended'

/**
 * The sector/difficulty stamp every lobby payload carries. `sector` is null
 * for the permanent free-play world, whose difficulty is FREE_PLAY_DIFFICULTY
 * (1 — no zone). Clients render zones straight off `difficulty`.
 */
export interface SectorStamp {
  sector: FreeplaySector | null
  difficulty: number
}

/** S→C `freeplay:joined` — the session handshake. */
export interface JoinedPayload extends SectorStamp {
  matchId: string
  /** The opaque session id (NOT the wallet). */
  playerId: string
  /** Which of the three modes this session is actually playing. */
  mode: FreeplayMode
  game: FreeplayGame
  status: WorldStatus
  entryFee: number
  world: {
    w: number
    h: number
    game: FreeplayGame
    bounds: WorldBounds
  }
  /** Server tick rate so the client can pace its input emits. */
  tick: number
  /** Lobby matches: ms until the first simulated tick (0 once running). */
  startsIn: number
  /** Lobby matches: the human roster (no bots, ever). */
  players: Array<{ id: string; name: string }>
}

/** S→C `freeplay:match_found` — the roster closed, countdown running. */
export interface MatchFoundPayload extends SectorStamp {
  game: FreeplayGame
  mode: FreeplayMode
  matchId: string
  startsIn: number
  players: Array<{ id: string; name: string }>
}

/** S→C `freeplay:match_state` — lifecycle transitions for lobby matches. */
export interface MatchStatePayload extends SectorStamp {
  game: FreeplayGame
  mode: FreeplayMode
  matchId: string
  status: WorldStatus
  /** Players still alive / total humans in the match. */
  alive: number
  total: number
  /** ms until 'running' while status is 'waiting'. */
  startsIn: number
}

/** One row of the end-of-match scoreboard. */
export interface StandingEntry {
  id: string
  name: string
  kills: number
  score: number
  /**
   * The number this row is RANKED on — the mode's "points":
   *   slayer → kills (nobody wins; kills are the whole scoreboard)
   *   lms    → score
   * Rendering `points` keeps the client from having to know the rule.
   */
  points: number
  /** LMS: 1 = winner. SLAYER: a kill RANKING only — place 1 is not a win. */
  place: number
  alive: boolean
}

/** S→C `freeplay:match_end` — the result screen payload. */
export interface MatchEndPayload extends SectorStamp {
  game: FreeplayGame
  mode: FreeplayMode
  matchId: string
  reason: 'last_standing' | 'timeout' | 'empty' | 'shutdown'
  /**
   * ALWAYS null in slayer — slayer has NO winner and no loser (contract).
   * LMS: the last player standing.
   */
  winner: { id: string; name: string } | null
  /**
   * What the scoreboard means. 'kills' = ranked kill-count board, render it
   * WITHOUT a victory/defeat verdict. 'survival' = the usual win/lose screen.
   */
  scoring: 'kills' | 'survival'
  standings: StandingEntry[]
}

// ─────────────────────────────────────────────────
// Errors — `freeplay:error { code, message }`
// ─────────────────────────────────────────────────

/**
 * Machine-readable error codes so the client never parses a human message.
 *
 * NOTE: `no_db` is intentionally GONE. Free play must run without a
 * database (contract: pot bookkeeping is best-effort, never a gate).
 */
export type FreeplayErrorCode =
  | 'already_active' // already in a DIFFERENT world on this socket
  | 'world_full' //     player cap reached
  | 'bad_payload' //    payload failed zod validation
  | 'join_failed' //    transient join refusal (mid-join collision, shutdown)
  | 'match_over' //     tried to act in an ended lobby match
  | 'cashout_failed' // cash-out claim lost (killed same instant) or DB error

/** One shared shape for every refusal so no emitter drifts on field names. */
export function emitFreeplayError(
  socket: Socket,
  code: FreeplayErrorCode,
  message: string
): void {
  socket.emit('freeplay:error', { code, message })
}
