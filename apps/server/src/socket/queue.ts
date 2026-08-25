/**
 * SHARED MATCHMAKING QUEUE — socket/queue.ts
 * ==========================================
 * ONE generic, idempotent queue used by EVERY lobby game (chess, volley,
 * connect, trivia, cells slayer/lms, asteroids slayer/lms, golf, clumsy,
 * pug shooter). Games keep their own gameplay state; this module owns only
 * "who is waiting for a match".
 *
 * WHY THIS EXISTS (verified root cause of "online refuses to search"):
 * the old per-game queues went SILENT when a wallet that was already queued
 * re-sent its find* event ("one slot per wallet, replace" took the quiet
 * path). The 2nd and every later click produced no server reply at all, and
 * since the clients only entered their searching state on the server echo,
 * the UI froze on the lobby. So the hard rule here is:
 *
 *   joinQueue() NEVER returns silently. Every call emits `queue:status`
 *   to the caller — first join, duplicate re-join, reconnect, all of them.
 *
 * WIRE CONTRACT
 * -------------
 *   S→C  queue:status { game, mode, inQueue, current, needed }
 *          inQueue:true   — you are queued; `current`/`needed` drive the
 *                           "PLAYERS: n / N" line on the searching screen.
 *                           Re-emitted to EVERY waiting player whenever the
 *                           queue size changes, so counts stay live.
 *          inQueue:false  — you are NOT queued and NO match started. This is
 *                           the only status that means "safe to show the
 *                           lobby again" (cancel, unmount, displaced slot).
 *
 *   IMPORTANT: a successful match does NOT emit `inQueue:false`. The searching
 *   overlay is cleared by the game's own start event (`gameStart`,
 *   `volleyGameStart`, `neonconnect_match`, `triviaGameStart`, …). If we
 *   emitted inQueue:false on match, a client that treats it as "cancelled"
 *   would bounce back to the lobby while its match is live on the server.
 *
 * LEGACY ACKS: the clients that already ship (`findGame`, `findVolleyGame`,
 * `neonconnect_join`, `findTriviaGame`) still expect their old `waiting` ack.
 * Pass `legacyAck` and BOTH events go out on every join — never one or the
 * other. Nothing legacy has to change to adopt this module.
 *
 * MATCHMAKING IS SKILL-BASED (rankingLogic.md §5.3)
 * -------------------------------------------------
 * Pass a `ladder` ('1v1' | 'ffa') and this queue stops pairing by arrival
 * order and starts pairing by HIDDEN SKILL — the mu of the TrueSkill rating
 * `services/rankService.ts` maintains. The objective from the spec is
 * "make P(win) ≈ 0.5", and for equally-sized sides that reduces to
 * minimising the spread of mu across the group, which is what we do:
 *
 *   1. every queued player carries a mu SNAPSHOT taken at join time (so the
 *      pairing step stays fully synchronous — see joinQueue),
 *   2. the LONGEST WAITER anchors the search: of all the groups containing
 *      them, the tightest one that fits inside their acceptance window wins,
 *   3. if nothing fits them, the next-longest waiter gets a turn, and so on.
 *
 * NOBODY STARVES. The spread a player will accept WIDENS with the time they
 * have waited (`allowedMuSpread`): it starts at ±MU_WINDOW_START, grows every
 * second, and becomes UNBOUNDED after MU_WINDOW_OPEN_AFTER_MS (~30s) — at
 * which point they take literally any opponent, exactly as the old FIFO queue
 * would have. Anchoring on seniority is what makes that guarantee real: a
 * lone high-rated player cannot be passed over indefinitely by a stream of
 * closely-matched newcomers. Because widening is time-based and joins are
 * event-driven, a queue that is big enough to match but too spread out ALSO
 * re-checks itself on a timer (MATCH_RETRY_MS) — otherwise two mismatched
 * players could sit there forever with no event to re-trigger pairing.
 *
 * Omit `ladder` and the queue behaves exactly as it did before: plain FIFO.
 *
 * RULES IMPLEMENTED
 * -----------------
 * - one queue slot per WALLET per GAME (across all of that game's modes);
 *   re-joining replaces the old slot, and a displaced OTHER socket of the
 *   same wallet is told `inQueue:false` so it can't sit on a ghost spinner
 * - SKILL pairing when a `ladder` is given, FIFO otherwise; either way the
 *   selected players are handed over in FIFO order (players[0] waited longest)
 * - stale entries (socket vanished without cleanup) are pruned on every touch
 * - disconnect cleanup is attached automatically, exactly once per socket,
 *   and matches by socket.id (never by wallet) so an old tab closing can't
 *   evict a live second session of the same wallet
 * - identity is ALWAYS socket.data.wallet / socket.data.username; wallets are
 *   server-side bookkeeping and are NEVER emitted to clients
 * - games requiring a registered account get the standard
 *   `gameAuthError { code:'no_account' }` refusal (plus an inQueue:false
 *   status so the optimistic client drops its searching screen)
 *
 * NO MONEY: this module never touches wagers, pots or NeonBucks. Queuing is
 * free, always, for every game.
 *
 * ---------------------------------------------------------------------------
 * USAGE EXAMPLE — how a game module adopts it (chess, 1v1):
 *
 *   import { joinQueue, leaveQueue, type QueueMatch } from '../queue'
 *
 *   interface ChessMeta { avatarUrl: string | null }
 *
 *   // The handoff: called once, with exactly `needed` connected players,
 *   // already joined to `match.room`. Build the game and emit the start.
 *   async function startChessMatch(match: QueueMatch<ChessMeta>) {
 *     const [a, b] = match.players            // FIFO order: a waited longer
 *     const white = Math.random() < 0.5 ? a : b
 *     const black = white === a ? b : a
 *     games.set(match.matchId, { gameId: match.matchId, room: match.room, ... })
 *     match.io.to(match.room).emit('gameStart', {
 *       mode: 'multiplayer',                  // literal is load-bearing
 *       gameId: match.matchId,                // room is `chess-${matchId}`
 *       whitePlayer: { socketId: white.socketId, name: white.username, ... },
 *       blackPlayer: { socketId: black.socketId, name: black.username, ... },
 *     })
 *   }
 *
 *   socket.on('findGame', async (payload: unknown) => {
 *     const parsed = findGameSchema.safeParse(payload ?? {})
 *     if (!parsed.success) return
 *     await joinQueue<ChessMeta>({
 *       socket,
 *       io,
 *       game: 'chess',
 *       mode: '1v1',
 *       needed: 2,
 *       ladder: '1v1',                        // pair on skill, not arrival
 *       meta: { avatarUrl: parsed.data.avatarUrl ?? null },
 *       // keeps the existing client working, alongside queue:status
 *       legacyAck: { event: 'waiting', payload: 'Waiting for opponent...' },
 *       onMatch: startChessMatch,
 *     })
 *   })
 *
 *   socket.on('leaveQueue', () => leaveQueue({ socket, io, game: 'chess' }))
 *   // disconnect cleanup is automatic — no extra wiring needed.
 * ---------------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto'
import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import type { RankLadder } from '@neon/types'
import { getSkill } from '../services/rankService'
import { MU_0, SIGMA_0 } from '../services/trueskill'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The one status event every searching screen listens to. */
export const QUEUE_STATUS_EVENT = 'queue:status'

/** Mode label used when a game has only one queue (chess, connect, golf…). */
export const DEFAULT_QUEUE_MODE = 'default'

/** Player-count bounds (design contract: min 2 so it is testable). The cap
 *  exists for the big-lobby games — cells/asteroids run 30-player worlds. */
export const MIN_PLAYERS = 2
export const MAX_PLAYERS = 30

// --- SKILL WINDOW (rankingLogic.md §5.3) -----------------------------------
// mu is on the TrueSkill scale (MU_0 = 25) and MMR = 100·mu, so 1 mu = 100
// MMR ≈ roughly one rank division. The numbers below are therefore readable
// as "how many divisions apart will I accept an opponent".

/** Spread a player accepts the instant they join: 2 mu = 200 MMR. */
export const MU_WINDOW_START = 2
/** How much wider that gets per second of waiting: 0.5 mu = 50 MMR/s. */
export const MU_WINDOW_GROWTH_PER_SEC = 0.5
/** After this long, ANY opponent is acceptable — the anti-starvation floor
 *  the contract asks for ("accept any opponent after ~30s"). */
export const MU_WINDOW_OPEN_AFTER_MS = 30_000
/** How often a too-spread-out queue re-checks itself. Pairing is triggered by
 *  joins, but the acceptable window widens with TIME, so a queue with enough
 *  players and no new events still needs a heartbeat or it would deadlock. */
export const MATCH_RETRY_MS = 1_000

/** Big-lobby queues only (`maxPlayers > needed`): once a match COULD start,
 *  hold it this long so a burst of joiners lands in ONE big world instead of
 *  a string of 2-player ones. Measured from the longest waiter's join, so it
 *  delays a quiet-hours pair by at most this much. */
export const LOBBY_GATHER_MS = 4_000

/** How long a private-party marker keeps protecting an entry that is still
 *  waiting for its partner. After this, the lone member is released to the
 *  public pool rather than waiting forever on a partner who never arrived. */
export const PARTY_GRACE_MS = 15_000

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Known game ids, with `(string & {})` so a new game can pass its own id
 * without editing this file while the listed ones still autocomplete.
 */
export type QueueGame =
  | 'chess'
  | 'volley'
  | 'connect'
  | 'kickoff'
  | 'cells'
  | 'asteroids'
  | 'golf'
  | 'clumsy'
  | 'pugshooter'
  | (string & {})

/** Exactly what `queue:status` carries. `mode` is null only when a leave
 *  targeted every mode of a game and the player held no slot at all. */
export interface QueueStatusPayload {
  game: QueueGame
  mode: string | null
  inQueue: boolean
  current: number
  needed: number
}

/**
 * The minimum a matchmaking candidate has to expose for `pickSkillGroup`.
 * Deliberately structural so the game modules that keep their OWN local
 * queues (connect, trivia 1v1) can reuse the same selection maths without
 * adopting this module wholesale.
 */
export interface SkillQueueEntry {
  /** TrueSkill mean, snapshotted when the player entered the queue. */
  mu: number
  /** Date.now() at join — drives the widening acceptance window. */
  joinedAt: number
}

/** A queued player. `wallet` is server-side only — NEVER emit it. */
export interface QueuePlayer<Meta = undefined> extends SkillQueueEntry {
  socketId: string
  wallet: string
  /**
   * PRIVATE-PARTY marker (server-stamped, see privateMatch.ts startRoom).
   * Members of one private room re-driven into a public queue carry the same
   * party id, and `selectPlayers` matches them with each other and ONLY each
   * other — no stranger can be swept into a private match, no member can be
   * poached by the public pool, and the pairing is immediate (no gather
   * hold). Null for every ordinary public join.
   */
  party: string | null
  /** How many members this party has IN TOTAL — the match waits for all of
   *  them, then takes the whole party in one group (a 3-friend FFA room must
   *  land in ONE world, never a pair + a stranded third). */
  partySize: number | null
  /** socket.data.username — the canonical display name (payloads are never
   *  trusted for identity). */
  username: string
  game: QueueGame
  mode: string
  joinedAt: number
  /**
   * HIDDEN SKILL SNAPSHOT, taken once at join time on the queue's `ladder`
   * (defaults to MU_0 / SIGMA_0 when there is no ladder, no row, or no DB).
   *
   * Snapshotting rather than reading it at pairing time is deliberate: it
   * keeps everything between "entry pushed" and "these two are matched"
   * SYNCHRONOUS, so no await window can open in which a disconnect strands a
   * half-built match. It is also fresh enough — one player's mu cannot move
   * while they sit in a queue, because rating only changes when a match they
   * were in ends.
   *
   * SERVER-ONLY. Never emit mu/sigma: the whole point of the two-layer model
   * is that RP is the visible number and skill is not.
   */
  mu: number
  sigma: number
  /** Game-specific extras the caller stashed at join time (avatarUrl,
   *  matchMode, chosen skin, …). Opaque to this module. */
  meta: Meta
}

/** What the game module receives when enough players are present. */
export interface QueueMatch<Meta = undefined> {
  io: Server
  game: QueueGame
  mode: string
  /** Fresh uuid — games normally reuse it as their gameId. */
  matchId: string
  /** `${game}-${matchId}`; every player socket is already joined to it. */
  room: string
  /** FIFO order — players[0] waited the longest. */
  players: QueuePlayer<Meta>[]
  /** Parallel to `players`; all verified connected at handoff time. */
  sockets: Socket[]
}

/** Handoff callback. Throwing puts the players back at the front of the
 *  queue and re-emits their status (they keep searching instead of hanging). */
export type QueueMatchHandler<Meta = undefined> = (
  match: QueueMatch<Meta>
) => void | Promise<void>

/** An extra event emitted next to `queue:status` for pre-existing clients. */
export interface LegacyAck {
  event: string
  payload?: unknown
}

export interface JoinQueueOptions<Meta = undefined> {
  socket: Socket
  game: QueueGame
  /** Sub-queue within the game ('1v1' | 'ffa' | 'classic' | 'slayer' | …). */
  mode?: string
  /** Players required to start (clamped to [MIN_PLAYERS, MAX_PLAYERS]). */
  needed: number
  /**
   * Sweep ceiling: when a match forms, take as many mutually-acceptable
   * players as are waiting, up to this many (clamped to
   * [needed, MAX_PLAYERS]). Omit for classic exact-size matches — the
   * default is `needed`, which is the pre-big-lobby behaviour byte for byte.
   */
  maxPlayers?: number
  onMatch: QueueMatchHandler<Meta>
  meta?: Meta
  /**
   * Which hidden-skill pool to pair on: '1v1' (chess, volley, connect, quiz
   * 1v1) or 'ffa' (quiz FFA, cells/asteroids slayer + lms). Omit — or pass
   * null — to keep the old plain-FIFO behaviour for a queue that has no
   * ranked ladder behind it.
   */
  ladder?: RankLadder | null
  /** Optional — derived from the socket's namespace when omitted. */
  io?: Server
  /** Emitted alongside queue:status on every join (legacy `waiting` ack). */
  legacyAck?: LegacyAck | null
  /** Join the matched sockets to `room` before the handoff (default true). */
  joinRoom?: boolean
  /** Skip the "must have a registered username" gate (default false). */
  allowGuests?: boolean
}

export interface LeaveQueueOptions {
  socket: Socket
  game: QueueGame
  /** Omit to leave every mode of this game. */
  mode?: string
  io?: Server
  /** Emitted alongside queue:status (e.g. a legacy 'queueLeft' ack). */
  legacyAck?: LegacyAck | null
  /** Don't emit to the leaver (used by disconnect cleanup). */
  silent?: boolean
}

export type QueueJoinResult =
  | {
      status: 'queued'
      game: QueueGame
      mode: string
      current: number
      needed: number
    }
  | {
      status: 'matched'
      game: QueueGame
      mode: string
      matchId: string
      room: string
    }
  | {
      status: 'rejected'
      reason: 'no_wallet' | 'no_account' | 'bad_options' | 'disconnected'
    }

// ---------------------------------------------------------------------------
// Zod — the scalar options are validated like any other untrusted input, so a
// caller (or a value derived from a client payload) can't create a 1-player or
// 5000-player queue. Meta stays opaque; the CALLER zod-parses its own payload.
// ---------------------------------------------------------------------------

const queueKeySchema = z.object({
  game: z.string().min(1).max(32),
  mode: z.string().min(1).max(32).default(DEFAULT_QUEUE_MODE),
  needed: z.coerce.number().int().min(MIN_PLAYERS).max(MAX_PLAYERS).catch(MIN_PLAYERS),
})

// ---------------------------------------------------------------------------
// Module state — in-memory, one process, same convention as the game modules
// ---------------------------------------------------------------------------

/**
 * Everything the retry heartbeat needs in order to complete a match WITHOUT
 * a fresh join event. Re-stamped on every join; every join to one
 * `${game}::${mode}` queue passes the same handler, so keeping the latest is
 * correct (and a queue that has never been joined has none, so it never
 * fires).
 */
interface QueueHandoff {
  onMatch: QueueMatchHandler<unknown>
  joinRoom: boolean
}

interface QueueRecord {
  game: QueueGame
  mode: string
  /** Kept in sync with the latest join so every status emit agrees. */
  needed: number
  /** Sweep ceiling (>= needed); equal to `needed` for exact-size queues. */
  maxPlayers: number
  /** Skill pool to pair on; null = plain FIFO (the pre-Ranked-2.0 behaviour). */
  ladder: RankLadder | null
  entries: QueuePlayer<unknown>[]
  /** Latest handoff, so the anti-starvation timer can finish a match. */
  handoff: QueueHandoff | null
  /** Pending re-check (see MATCH_RETRY_MS); null when none is armed. */
  retryTimer: ReturnType<typeof setTimeout> | null
}

/** `${game}::${mode}` → record. */
const queues = new Map<string, QueueRecord>()

/** Sockets that already own a disconnect-cleanup listener (attach once). */
const cleanupAttached = new WeakSet<Socket>()

const keyOf = (game: QueueGame, mode: string) => `${game}::${mode}`

// ---------------------------------------------------------------------------
// SKILL SELECTION (§5.3) — pure, exported so the game modules that still own
// a local queue (connect, trivia 1v1) share exactly this maths.
// ---------------------------------------------------------------------------

/**
 * The widest mu spread a player who has waited `waitedMs` will accept.
 *
 * Starts tight (MU_WINDOW_START ≈ 200 MMR — a genuinely even match), widens
 * linearly, and goes UNBOUNDED at MU_WINDOW_OPEN_AFTER_MS so queue times can
 * never regress past the old FIFO behaviour. This is the whole anti-starvation
 * mechanism: a player alone at the top of the ladder waits ~30 seconds for a
 * fair match and then takes whoever is there.
 */
export function allowedMuSpread(waitedMs: number): number {
  if (!Number.isFinite(waitedMs)) return Infinity
  if (waitedMs >= MU_WINDOW_OPEN_AFTER_MS) return Infinity
  return MU_WINDOW_START + (Math.max(0, waitedMs) / 1000) * MU_WINDOW_GROWTH_PER_SEC
}

/**
 * Pick the best `needed`-player group out of `entries`, or null when nobody
 * can be matched yet.
 *
 * THE OBJECTIVE (§5.3) is "make P(win) ≈ 0.5", which for equally-sized sides
 * means minimising the SPREAD of mu across the group. Sorting by mu makes
 * that easy: the tightest group of size N is always N CONSECUTIVE entries in
 * that order, so a linear sweep finds the optimum — no combinatorial search.
 * For `needed === 2` this is exactly "minimise |mu_a − mu_b|".
 *
 * THE ANTI-STARVATION RULE is why this is not just "take the tightest window
 * anywhere". Candidates are considered ANCHORED ON THE LONGEST WAITER first:
 *
 *   1. take the player who has waited longest,
 *   2. of all the groups containing them, take the tightest one whose spread
 *      fits inside THEIR acceptance window (which is the widest in the queue,
 *      because it grows with waiting — and is unbounded past ~30s),
 *   3. if nothing fits, move on to the next-longest waiter and repeat.
 *
 * Step 3 is what still lets two closely-matched newcomers pair off while a
 * far-away veteran keeps waiting; step 2 is what guarantees that once that
 * veteran has waited ~30s they take the nearest opponent available and the
 * queue cannot pass them over again. Scoring a window by the STRICTEST member
 * instead (mutual consent, the obvious design) would let a stream of
 * short-lived newcomers refuse a lone high-rated player forever, which is
 * precisely the starvation the contract forbids.
 *
 * The trade-off, stated plainly: a player who just joined can be pulled into
 * a lopsided match by someone who has been waiting a long time. That is the
 * intended reading of "accept any opponent after ~30s" — a slightly unfair
 * match beats an infinite queue, and the RP layer is designed for it (beating
 * someone far below you pays almost nothing).
 *
 * The winning group is returned in FIFO order (`players[0]` waited longest),
 * because game modules rely on that: volley's players[0] is the left paddle,
 * connect's is player 1.
 */
export function pickSkillGroup<T extends SkillQueueEntry>(
  entries: readonly T[],
  needed: number,
  now: number = Date.now()
): T[] | null {
  if (needed < 1 || entries.length < needed) return null

  const byMu = [...entries].sort((a, b) => a.mu - b.mu || a.joinedAt - b.joinedAt)
  const bySeniority = [...entries].sort((a, b) => a.joinedAt - b.joinedAt)

  for (const anchor of bySeniority) {
    // The anchor is the most patient player still unmatched, so their window
    // is the widest — no other member of the group can veto it.
    const allowed = allowedMuSpread(now - anchor.joinedAt)
    const at = byMu.indexOf(anchor)

    // Every window of `needed` consecutive entries that CONTAINS the anchor.
    const first = Math.max(0, at - needed + 1)
    const last = Math.min(at, byMu.length - needed)

    let best: T[] | null = null
    let bestSpread = Infinity
    for (let i = first; i <= last; i++) {
      const window = byMu.slice(i, i + needed)
      // Sorted by mu, so the extremes are the ends of the window.
      const spread = window[needed - 1].mu - window[0].mu
      if (spread > allowed) continue // still too far apart for this anchor
      if (spread < bestSpread) {
        best = window
        bestSpread = spread
      }
    }

    if (best) return [...best].sort((a, b) => a.joinedAt - b.joinedAt)
  }

  return null
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** The Server instance — explicit `io` wins, otherwise derive from the socket. */
function resolveIo(socket: Socket, io?: Server): Server {
  return io ?? (socket.nsp.server as unknown as Server)
}

function getRecord(
  game: QueueGame,
  mode: string,
  needed: number,
  maxPlayers: number,
  ladder: RankLadder | null = null
): QueueRecord {
  const key = keyOf(game, mode)
  let record = queues.get(key)
  if (!record) {
    record = {
      game,
      mode,
      needed,
      maxPlayers,
      ladder,
      entries: [],
      handoff: null,
      retryTimer: null,
    }
    queues.set(key, record)
  } else {
    // Keep the newest requirement so waiting players and joiners see the same
    // "PLAYERS: n / N" denominator.
    record.needed = needed
    record.maxPlayers = maxPlayers
    record.ladder = ladder
  }
  return record
}

/** Drop entries whose socket is gone. Returns true when anything changed. */
function pruneStale(io: Server, record: QueueRecord): boolean {
  const before = record.entries.length
  record.entries = record.entries.filter((entry) => {
    const s = io.sockets.sockets.get(entry.socketId)
    return s !== undefined && !s.disconnected
  })
  return record.entries.length !== before
}

function statusPayload(
  record: QueueRecord,
  inQueue: boolean
): QueueStatusPayload {
  return {
    game: record.game,
    mode: record.mode,
    inQueue,
    current: record.entries.length,
    // The denominator players SEE. For exact-size queues this IS `needed`;
    // for big-lobby sweep queues it is the world cap ("PLAYERS 3/30"), since
    // "n / 2" would overflow the moment a third player gathers.
    needed: record.maxPlayers,
  }
}

/** Push the live count to everyone still waiting in this queue. */
function broadcastCounts(io: Server, record: QueueRecord): void {
  const payload = statusPayload(record, true)
  for (const entry of record.entries) {
    io.sockets.sockets.get(entry.socketId)?.emit(QUEUE_STATUS_EVENT, payload)
  }
}

/** Emit queue:status (+ optional legacy ack) to one socket. */
function emitStatus(
  socket: Socket,
  payload: QueueStatusPayload,
  legacyAck?: LegacyAck | null
): void {
  socket.emit(QUEUE_STATUS_EVENT, payload)
  if (legacyAck) socket.emit(legacyAck.event, legacyAck.payload)
}

/**
 * When did this wallet FIRST start waiting for this game? Undefined when it
 * holds no slot.
 *
 * Load-bearing for anti-starvation: a re-join replaces the slot, and if that
 * also reset `joinedAt` then a client that re-emits its find* event on every
 * remount (or every few seconds, as some of ours do) would keep resetting its
 * own acceptance window and could never widen out of a narrow skill band.
 * Carrying the ORIGINAL timestamp forward makes the wait clock honest.
 */
function priorJoinedAt(game: QueueGame, wallet: string): number | undefined {
  let earliest: number | undefined
  for (const record of queues.values()) {
    if (record.game !== game) continue
    for (const entry of record.entries) {
      if (entry.wallet !== wallet) continue
      if (earliest === undefined || entry.joinedAt < earliest) earliest = entry.joinedAt
    }
  }
  return earliest
}

/**
 * Remove every slot held by `wallet` in ANY mode of `game` (one slot per
 * wallet per game). Sockets OTHER than `keepSocketId` that lose their slot are
 * told `inQueue:false` so they can't sit on a ghost searching screen.
 * Returns the records that changed so their counts can be re-broadcast.
 */
function releaseWalletSlots(
  io: Server,
  game: QueueGame,
  wallet: string,
  keepSocketId: string
): QueueRecord[] {
  const touched: QueueRecord[] = []
  for (const record of queues.values()) {
    if (record.game !== game) continue
    const displaced = record.entries.filter((e) => e.wallet === wallet)
    if (displaced.length === 0) continue
    record.entries = record.entries.filter((e) => e.wallet !== wallet)
    touched.push(record)
    for (const entry of displaced) {
      if (entry.socketId === keepSocketId) continue // the re-joiner itself
      io.sockets.sockets
        .get(entry.socketId)
        ?.emit(QUEUE_STATUS_EVENT, statusPayload(record, false))
    }
  }
  return touched
}

// ---------------------------------------------------------------------------
// MATCH FORMATION — one code path shared by joins and by the retry heartbeat
// ---------------------------------------------------------------------------

/**
 * Which players (if any) should be matched right now. FIFO when the queue has
 * no ladder, skill-windowed when it does. Returns entries that are still IN
 * `record.entries` — removing them is the caller's job, so a failed handoff
 * can put them back.
 */
function selectPlayers(record: QueueRecord, now: number): QueuePlayer<unknown>[] | null {
  if (record.entries.length < record.needed) return null

  // PRIVATE PARTIES FIRST. A complete party pairs with itself, immediately —
  // no gather hold, no skill window, no strangers. A party whose partner
  // never arrived (their socket died between the dispatches) is released to
  // the public pool after PARTY_GRACE_MS so it cannot wait forever.
  const byParty = new Map<string, QueuePlayer<unknown>[]>()
  for (const entry of record.entries) {
    if (!entry.party) continue
    if (now - entry.joinedAt > PARTY_GRACE_MS) {
      entry.party = null
      continue
    }
    const group = byParty.get(entry.party)
    if (group) group.push(entry)
    else byParty.set(entry.party, [entry])
  }
  for (const members of byParty.values()) {
    // Wait for the WHOLE party (the dispatch fan-out enqueues them one at a
    // time — matching at `needed` used to split a 3+ room into a pair plus
    // stranded leftovers), then take the whole party in one group.
    const size = members[0]?.partySize ?? record.needed
    if (members.length >= size && members.length >= record.needed) {
      return members.slice(0, Math.max(record.needed, record.maxPlayers))
    }
  }

  // Everything below sees ONLY the public pool: entries still waiting on a
  // party partner are invisible to sweeps and pairing.
  const pool = record.entries.filter((entry) => !entry.party)
  if (pool.length < record.needed) return null

  // Big-lobby gather hold: enough players to start, but room for more. Wait
  // LOBBY_GATHER_MS from the LONGEST waiter's join before committing, so a
  // burst of joiners coalesces into one world. A full house skips the hold,
  // and the retry heartbeat guarantees the deferred attempt happens.
  if (
    record.maxPlayers > record.needed &&
    pool.length < record.maxPlayers &&
    // Not pool[0]: a re-join re-appends its entry while KEEPING the
    // original joinedAt, so position is not wait order.
    now - Math.min(...pool.map((e) => e.joinedAt)) < LOBBY_GATHER_MS
  ) {
    return null
  }

  const cap = Math.min(record.maxPlayers, pool.length)
  if (!record.ladder) {
    // Legacy behaviour, byte for byte, when no sweep was asked for: the
    // longest-waiting `needed` players. With a sweep ceiling, FIFO simply
    // takes everyone waiting, up to the cap.
    return pool.slice(0, cap)
  }
  // Prefer the BIGGEST group the acceptance windows allow right now — a
  // smaller group is only formed when no larger one is mutually acceptable.
  for (let size = cap; size >= record.needed; size--) {
    const group = pickSkillGroup(pool, size, now)
    if (group) return group
  }
  return null
}

/**
 * Arm (or leave armed) the anti-starvation re-check.
 *
 * Only meaningful for a skill-paired queue that has enough players but no
 * acceptable grouping yet: their acceptance windows widen with wall-clock
 * time, and nothing else would ever re-run the matcher. Unref'd so a waiting
 * queue can never hold the process open.
 */
function scheduleRetry(io: Server, record: QueueRecord): void {
  if (record.retryTimer) return
  if (!record.handoff) return
  // Only time-driven queues need a heartbeat: skill windows widen with the
  // clock, the big-lobby gather hold expires with it, and so does the
  // PARTY_GRACE_MS release of a stranded party member. A plain exact-size
  // FIFO queue with no party entries can only change on a join, which
  // re-runs the matcher anyway.
  if (
    !record.ladder &&
    record.maxPlayers === record.needed &&
    !record.entries.some((entry) => entry.party)
  ) {
    return
  }
  if (record.entries.length < record.needed) return

  const timer = setTimeout(() => {
    record.retryTimer = null
    void runRetry(io, record)
  }, MATCH_RETRY_MS)
  ;(timer as { unref?: () => void }).unref?.()
  record.retryTimer = timer
}

/** One heartbeat: try to form a match, then re-arm if one is still possible. */
async function runRetry(io: Server, record: QueueRecord): Promise<void> {
  const handoff = record.handoff
  if (!handoff) return
  try {
    await formMatch(io, record, handoff)
  } catch (err) {
    // formMatch already swallows onMatch failures; this is belt-and-braces so
    // a timer callback can never take the process down.
    console.error(`[queue] ${record.game}/${record.mode} retry failed:`, err)
  }
  scheduleRetry(io, record)
}

/**
 * Try to start ONE match out of `record`. Returns the match descriptor, or
 * null when nothing could be formed (not enough players, everyone too far
 * apart, or the handoff threw and the players were put back).
 *
 * Everything from "selected" to "removed from the queue" is synchronous, so
 * two overlapping callers (a join racing the retry timer) can never hand the
 * same player to two matches: whoever runs first has already taken them out.
 */
async function formMatch(
  io: Server,
  record: QueueRecord,
  handoff: QueueHandoff,
  now: number = Date.now()
): Promise<{ matchId: string; room: string; players: QueuePlayer<unknown>[] } | null> {
  pruneStale(io, record)

  const chosen = selectPlayers(record, now)
  if (!chosen) return null

  // Re-resolve the sockets. pruneStale just ran, so these are live; the check
  // exists because a socket can drop between the two statements in principle.
  const sockets: Socket[] = []
  for (const player of chosen) {
    const s = io.sockets.sockets.get(player.socketId)
    if (!s || s.disconnected) {
      // Drop the corpse and give up on this attempt — the next join (or the
      // next heartbeat) re-selects from what is actually left.
      record.entries = record.entries.filter((e) => e.socketId !== player.socketId)
      return null
    }
    sockets.push(s)
  }

  // Commit: take them out of the queue BEFORE any await.
  const chosenIds = new Set(chosen.map((p) => p.socketId))
  record.entries = record.entries.filter((e) => !chosenIds.has(e.socketId))

  const matchId = randomUUID()
  const room = `${record.game}-${matchId}` // matches `chess-${gameId}` etc.
  if (handoff.joinRoom) for (const s of sockets) s.join(room)

  const match: QueueMatch<unknown> = {
    io,
    game: record.game,
    mode: record.mode,
    matchId,
    room,
    players: chosen,
    sockets,
  }

  try {
    await handoff.onMatch(match)
  } catch (err) {
    // The game module blew up building the match: undo the room join, put the
    // players back at the FRONT and re-emit their status. They stay on the
    // searching screen (and can cancel) instead of hanging on a dead match.
    console.error(`[queue] ${record.game}/${record.mode} onMatch failed:`, err)
    if (handoff.joinRoom) for (const s of sockets) s.leave(room)
    record.entries.unshift(...chosen)
    broadcastCounts(io, record)
    return null
  }

  // Anyone still waiting (FFA overflow) gets a fresh count.
  if (record.entries.length > 0) broadcastCounts(io, record)

  return { matchId, room, players: chosen }
}

/**
 * Disconnect cleanup, attached lazily and exactly once per socket so the
 * module needs no wiring in socket/index.ts. Matches by socket.id — never by
 * wallet — so closing an old tab can't dequeue a live second session.
 */
export function attachQueueCleanup(socket: Socket, io?: Server): void {
  if (cleanupAttached.has(socket)) return
  cleanupAttached.add(socket)
  const server = resolveIo(socket, io)
  socket.on('disconnect', () => {
    for (const record of queues.values()) {
      const before = record.entries.length
      record.entries = record.entries.filter((e) => e.socketId !== socket.id)
      // Only bother the survivors when this queue actually shrank.
      if (record.entries.length !== before) broadcastCounts(server, record)
    }
  })
}

// ---------------------------------------------------------------------------
// joinQueue — THE idempotent, never-silent entry point
// ---------------------------------------------------------------------------

/**
 * Put the caller in a queue and, when enough players are present, hand them
 * to the game module.
 *
 * ALWAYS emits `queue:status` to the caller before returning — including on a
 * duplicate re-join, which is exactly the silence that made online play look
 * broken. Safe to call as many times as the client clicks.
 */
export async function joinQueue<Meta = undefined>(
  options: JoinQueueOptions<Meta>
): Promise<QueueJoinResult> {
  const { socket, onMatch, legacyAck = null, joinRoom = true } = options
  const io = resolveIo(socket, options.io)

  // --- validate the queue coordinates -------------------------------------
  const parsed = queueKeySchema.safeParse({
    game: options.game,
    mode: options.mode ?? DEFAULT_QUEUE_MODE,
    needed: options.needed,
  })
  if (!parsed.success) {
    console.error('[queue] bad joinQueue options', options.game, options.mode)
    return { status: 'rejected', reason: 'bad_options' }
  }
  const { game, mode, needed } = parsed.data

  // --- identity (handshake auth only; payloads are never trusted) ---------
  const wallet = socket.data.wallet as string | undefined
  if (!wallet) {
    // Can't happen behind socketAuth, but never trust it.
    return { status: 'rejected', reason: 'no_wallet' }
  }
  const username = (socket.data.username as string | null | undefined) ?? null
  if (!username && !options.allowGuests) {
    // Standard refusal shared by every game module. The inQueue:false status
    // is what lets an optimistic client drop its searching screen instead of
    // spinning forever.
    socket.emit('gameAuthError', {
      code: 'no_account',
      message: 'Finish account setup to play online',
    })
    socket.emit(QUEUE_STATUS_EVENT, {
      game,
      mode,
      inQueue: false,
      current: 0,
      needed,
    } satisfies QueueStatusPayload)
    return { status: 'rejected', reason: 'no_account' }
  }

  attachQueueCleanup(socket, io)

  // --- hidden skill snapshot ----------------------------------------------
  // Taken HERE, before the entry exists, so that everything from "queued" to
  // "matched" below stays synchronous (see QueuePlayer.mu). getSkill never
  // throws and always resolves — {MU_0, SIGMA_0} when there is no ladder, no
  // users row or no database — so matchmaking degrades to "everyone is
  // average", i.e. back to FIFO-ish behaviour, rather than failing.
  const ladder = options.ladder ?? null
  const skill = ladder ? await getSkill(wallet, ladder) : null
  if (socket.disconnected) {
    // They gave up (or the tab closed) during the lookup — never enqueue a
    // corpse, and there is nobody left to ack.
    return { status: 'rejected', reason: 'disconnected' }
  }

  // Clamp the sweep ceiling server-side (callers pass literals, but the
  // record must always satisfy needed <= maxPlayers <= MAX_PLAYERS).
  const maxPlayers = Math.max(
    needed,
    Math.min(options.maxPlayers ?? needed, MAX_PLAYERS)
  )
  const record = getRecord(game, mode, needed, maxPlayers, ladder)
  // Remember how to finish a match without a fresh join event (see runRetry).
  record.handoff = {
    onMatch: onMatch as QueueMatchHandler<unknown>,
    joinRoom,
  }

  // --- one slot per wallet per game (re-join REPLACES the old slot) -------
  // Read the original wait clock BEFORE the old slot is dropped (see
  // priorJoinedAt: a re-join must not reset it).
  const waitingSince = priorJoinedAt(game, wallet) ?? Date.now()
  const touched = releaseWalletSlots(io, game, wallet, socket.id)
  pruneStale(io, record)

  // PRIVATE PARTY: privateMatch.startRoom stamps socket.data.privateParty
  // ({id, until}) just before re-driving each member's find event. Read at
  // join time, honoured only while fresh — a stale stamp from a finished
  // match must never tag an ordinary public join. socket.data is server-side
  // only, so a client can never forge its way into someone's party.
  const stamp = socket.data.privateParty as
    | { id?: unknown; size?: unknown; until?: unknown }
    | undefined
  const stampFresh =
    stamp &&
    typeof stamp.id === 'string' &&
    typeof stamp.until === 'number' &&
    stamp.until > Date.now()
  const party = stampFresh ? (stamp.id as string) : null
  const partySize =
    stampFresh && typeof stamp.size === 'number' && stamp.size >= 2
      ? Math.floor(stamp.size)
      : null

  const entry: QueuePlayer<Meta> = {
    socketId: socket.id,
    wallet,
    username: username ?? 'Guest',
    game,
    mode,
    party,
    partySize,
    // A party entry gets a FRESH clock. `waitingSince` inherits the player's
    // old public wait (priorJoinedAt spans every mode of the game), and an
    // inherited 15s+ clock would trip the PARTY_GRACE_MS demotion on the very
    // first selection pass — dumping a private-room member straight into the
    // public pool with a wide-open skill window. The party pairs with itself
    // immediately, so the lost queue priority costs nothing.
    joinedAt: party ? Date.now() : waitingSince,
    mu: skill?.mu ?? MU_0,
    sigma: skill?.sigma ?? SIGMA_0,
    meta: options.meta as Meta,
  }
  record.entries.push(entry as QueuePlayer<unknown>)

  // --- NEVER SILENT: the caller always hears back, duplicates included ----
  emitStatus(socket, statusPayload(record, true), legacyAck)
  // Live "PLAYERS: n / N" for everyone else already waiting here…
  for (const other of record.entries) {
    if (other.socketId === socket.id) continue
    io.sockets.sockets
      .get(other.socketId)
      ?.emit(QUEUE_STATUS_EVENT, statusPayload(record, true))
  }
  // …and for any OTHER queue of this game whose count changed above.
  for (const other of touched) {
    if (other !== record) broadcastCounts(io, other)
  }

  // --- try to form a match -------------------------------------------------
  // `formMatch` decides FIFO-vs-skill, does the room join and calls the game
  // module. Null means "keep waiting" — not enough players, or nobody in this
  // queue is currently a close enough opponent for anybody else.
  const queued = (): QueueJoinResult => ({
    status: 'queued',
    game,
    mode,
    current: record.entries.length,
    needed: record.needed,
  })

  const formed = await formMatch(io, record, record.handoff)
  // A skill queue that is big enough but too spread out (or that still has
  // leftovers after this match) re-checks itself until the widening window
  // lets someone in. Self-guarding: a no-ladder or under-full queue no-ops.
  scheduleRetry(io, record)

  if (!formed) return queued()

  // The caller normally IS in the match — but skill pairing can perfectly well
  // match two OTHER players and leave the joiner waiting, so report the truth
  // rather than a match they aren't in.
  if (!formed.players.some((p) => p.socketId === socket.id)) return queued()

  // NOTE: deliberately NO inQueue:false here — the game's own start event
  // clears the searching screen (see the header).
  return { status: 'matched', game, mode, matchId: formed.matchId, room: formed.room }
}

// ---------------------------------------------------------------------------
// leaveQueue — cancel / unmount / view change
// ---------------------------------------------------------------------------

/**
 * Take the caller out of a game's queue (one mode, or all of them) and emit
 * `queue:status { inQueue: false }`. Idempotent and never silent: a player who
 * wasn't queued still gets the status, so a stuck client can always recover.
 */
export function leaveQueue(options: LeaveQueueOptions): { left: number } {
  const { socket, game, mode, legacyAck = null, silent = false } = options
  const io = resolveIo(socket, options.io)

  let left = 0
  const affected: QueueRecord[] = []

  for (const record of queues.values()) {
    if (record.game !== game) continue
    if (mode && record.mode !== mode) continue
    const before = record.entries.length
    // Match by socket.id: a second live session of the same wallet keeps its
    // own slot when this one leaves.
    record.entries = record.entries.filter((e) => e.socketId !== socket.id)
    if (record.entries.length === before) continue
    left += before - record.entries.length
    affected.push(record)
  }

  if (!silent) {
    if (affected.length > 0) {
      for (const record of affected) {
        emitStatus(socket, statusPayload(record, false), legacyAck)
      }
    } else {
      // Wasn't queued — still answer, so "cancel" always resolves the UI.
      emitStatus(
        socket,
        {
          game,
          mode: mode ?? null,
          inQueue: false,
          current: 0,
          needed: 0,
        },
        legacyAck
      )
    }
  }

  // Everyone still waiting sees the count drop.
  for (const record of affected) broadcastCounts(io, record)

  return { left }
}

/**
 * Drop the socket from EVERY queue of every game (view change / hard reset).
 * Emits one `inQueue:false` per queue it actually left; pass `silent` when the
 * socket is already gone.
 */
export function leaveAllQueues(
  socket: Socket,
  opts: { io?: Server; silent?: boolean } = {}
): { left: number } {
  const io = resolveIo(socket, opts.io)
  let left = 0
  for (const record of queues.values()) {
    const before = record.entries.length
    record.entries = record.entries.filter((e) => e.socketId !== socket.id)
    if (record.entries.length === before) continue
    left += before - record.entries.length
    if (!opts.silent) {
      socket.emit(QUEUE_STATUS_EVENT, statusPayload(record, false))
    }
    broadcastCounts(io, record)
  }
  return { left }
}

// ---------------------------------------------------------------------------
// Read-only helpers (HUD counts, tests, debugging)
// ---------------------------------------------------------------------------

/** How many players are waiting in `game`/`mode` right now. */
export function getQueueSize(
  game: QueueGame,
  mode: string = DEFAULT_QUEUE_MODE
): number {
  return queues.get(keyOf(game, mode))?.entries.length ?? 0
}

/** Is this socket queued for `game` (any mode, or a specific one)? */
export function isQueued(
  socket: Socket,
  game: QueueGame,
  mode?: string
): boolean {
  for (const record of queues.values()) {
    if (record.game !== game) continue
    if (mode && record.mode !== mode) continue
    if (record.entries.some((e) => e.socketId === socket.id)) return true
  }
  return false
}

/** Is this WALLET holding a slot in `game` (any mode)? One slot per wallet. */
export function isWalletQueued(wallet: string, game: QueueGame): boolean {
  for (const record of queues.values()) {
    if (record.game !== game) continue
    if (record.entries.some((e) => e.wallet === wallet)) return true
  }
  return false
}

/** Snapshot of every non-empty queue — debugging / ops only. */
export function queueSnapshot(): Array<{
  game: QueueGame
  mode: string
  current: number
  needed: number
}> {
  const out: Array<{
    game: QueueGame
    mode: string
    current: number
    needed: number
  }> = []
  for (const record of queues.values()) {
    if (record.entries.length === 0) continue
    out.push({
      game: record.game,
      mode: record.mode,
      current: record.entries.length,
      needed: record.needed,
    })
  }
  return out
}
