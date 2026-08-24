/**
 * CONNECT 4 — server-authoritative board, rematch handshake
 * =========================================================
 * The reference server was a blind relay (no board, no turn checks, clients
 * declared their own wins). This port makes the SERVER the source of truth:
 * it owns the board, validates every drop, detects win/draw itself, and
 * declares results — the client relay events stay byte-compatible.
 *
 * Client contract (NeonConnect/NeonConnectGame.tsx):
 *
 *   C→S  neonconnect_join { profile }     — enter the skill-based queue
 *   C→S  leaveConnectQueue                — NEW: leave the queue (no payload)
 *   C→S  neonconnect_move { col }         — drop a disc in column 0..6
 *   C→S  neonconnect_reset                — request a rematch (handshake)
 *   S→C  queue:status { game, mode, inQueue, current, needed } — ALWAYS sent
 *        on every join/leave, including duplicate joins (see below)
 *   S→C  neonconnect_match { opponent, turn, playerId } — per-player payload
 *   S→C  neonconnect_opponent_move { col }              — opponent only
 *   S→C  neonconnect_ended { winner: 1|2|'draw', reason:'connect4'|'draw' }
 *   S→C  neonconnect_reset { turn }       — ROOM broadcast when BOTH agreed
 *   S→C  neonconnect_opponent_quit       — opponent left/disconnected
 *   S→C  gameAuthError { code, message } — matchmaking refused (no account)
 *
 * Board model: number[42], row-major with row 0 at the TOP (row 5 is the
 * bottom where gravity lands discs). 0 = empty, 1 = player 1, 2 = player 2.
 * The first-queued player is playerId 1 and moves first in game one.
 *
 * Identity: socket.data.wallet / socket.data.username (handshake auth).
 * Wallets are server-side bookkeeping ONLY and are never emitted.
 */

import { randomUUID } from 'node:crypto'
import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
// RANKED 2.0 — TrueSkill + RP. Connect 4 is on the '1v1' ladder and DOES
// have draws (a full board), which the model handles natively.
import { getSkill, settleRanked1v1 } from '../../services/rankService'
// Stats ride along with the rating settle inside settleOnce(), so both are
// covered by the same exactly-once guard (`eloSettled`).
import { recordAndEmitProgression } from './progression'
// Connect keeps its OWN queue (its per-player `neonconnect_match` payload
// doesn't fit the shared handoff), but it reuses the shared skill-selection
// maths so every 1v1 in the arcade pairs by the same rule.
import {
  MATCH_RETRY_MS,
  PARTY_GRACE_MS,
  pickSkillGroup,
  type SkillQueueEntry,
} from '../queue'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROWS = 6
const COLS = 7
const CELLS = ROWS * COLS // 42

// Matchmaking is 1v1 — two humans, no bots, no stake of any kind.
const NEEDED_PLAYERS = 2

// The four line directions that cover every possible 4-in-a-row once we
// scan from every cell: right, down, down-right, down-left. (Left/up runs
// are found from their other endpoint.)
const WIN_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // horizontal →
  [1, 0], // vertical ↓
  [1, 1], // diagonal ↘
  [1, -1], // diagonal ↙
]

// ---------------------------------------------------------------------------
// Types + module-level registries (one per process — in-memory by design)
// ---------------------------------------------------------------------------

type PlayerId = 1 | 2
type ConnectWinner = PlayerId | 'draw'

interface ConnectPlayer {
  socketId: string
  wallet: string // NEVER emitted — pairing rules + rating only
  name: string // canonical: socket.data.username
}

/**
 * A player waiting in the queue. Carries the HIDDEN skill snapshot (mu) taken
 * at join time plus the wait clock, which is everything `pickSkillGroup`
 * needs. Both are SERVER-ONLY and never appear in any emitted payload.
 */
interface ConnectQueueEntry extends ConnectPlayer, SkillQueueEntry {
  /** PRIVATE-PARTY marker — see socket/queue.ts QueuePlayer.party. Connect
   *  keeps its own local queue, so it honours the same server-side stamp
   *  privateMatch leaves on the socket; without this a private Connect
   *  room's members would land unprotected in the public pool. */
  party: string | null
}

interface ConnectGame {
  gameId: string
  room: string // `connect-${gameId}`
  p1: ConnectPlayer // first-queued — playerId 1
  p2: ConnectPlayer // joiner — playerId 2
  board: number[] // 42 cells, see file header for layout
  turn: PlayerId
  status: 'active' | 'ended'
  winner: ConnectWinner | null // last finished game's result (drives rematch)
  resetRequested: Record<PlayerId, boolean> // rematch handshake flags
  /** Exactly-once guard around rankService.settleRanked1v1 + the stats write.
   *  Cleared on a rematch so the NEW game settles on its own. */
  eloSettled: boolean
  /** Wall-clock start of the CURRENT game (re-stamped on a rematch) — feeds
   *  match_results.durationMs. Stats only; no gameplay depends on it. */
  startedAt: number
}

/** Waiting room. Pairing is by SKILL (nearest mu, widening window), not by
 *  arrival order — see tryPair() below. */
const queue: ConnectQueueEntry[] = []
// gameId → game, plus a socket.id → gameId index for O(1) lookups.
const games = new Map<string, ConnectGame>()
const gameBySocket = new Map<string, string>()

/**
 * Anti-starvation heartbeat. Pairing normally runs on a join, but the skill
 * window that decides "is this opponent close enough" widens with WALL-CLOCK
 * TIME — so two mismatched players sitting in an otherwise idle queue would
 * never be re-considered without a tick. Unref'd: it never holds the process
 * open, and it is only armed while two or more people are actually waiting.
 */
let retryTimer: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------------------
// Zod schemas — every inbound payload is safeParse'd; bad shapes are ignored
// ---------------------------------------------------------------------------

// The profile is client-supplied and COSMETIC only — the opponent name we
// broadcast is always the registered username from the handshake.
const joinSchema = z.object({
  profile: z
    .object({
      name: z.string().max(64).optional(),
      avatarUrl: z.string().max(512).optional(),
    })
    .nullish(),
})

const moveSchema = z.object({
  col: z.number().int().min(0).max(6),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove every queue entry matching the predicate (splice in place). */
function removeFromQueue(match: (entry: ConnectQueueEntry) => boolean): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (match(queue[i])) queue.splice(i, 1)
  }
}

/**
 * Uniform, ALWAYS-SENT queue acknowledgement.
 *
 * The old code answered a join with silence whenever the caller was already
 * queued (the "one slot per wallet, replace" path) or already bound to a
 * game — so a client that re-sent `neonconnect_join` (a remount, a reconnect,
 * a stale entry from a previous visit) got nothing back and hung forever.
 * Every join/leave path below ends in one of these, duplicates included.
 */
function emitQueueStatus(socket: Socket, inQueue: boolean): void {
  socket.emit('queue:status', {
    game: 'connect',
    mode: '1v1',
    inQueue,
    current: inQueue ? 1 : 0, // this client's own slot; 1v1 needs no roster
    needed: NEEDED_PLAYERS,
  })
}

/** The game a socket is bound to, or null. */
function gameOf(socketId: string): ConnectGame | null {
  const gameId = gameBySocket.get(socketId)
  return gameId ? (games.get(gameId) ?? null) : null
}

/** Which seat a socket occupies in a game, or null if not a participant. */
function idOf(game: ConnectGame, socketId: string): PlayerId | null {
  if (game.p1.socketId === socketId) return 1
  if (game.p2.socketId === socketId) return 2
  return null
}

/** True when `playerId` has any 4-in-a-row on the board. */
function hasWon(board: number[], playerId: PlayerId): boolean {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r * COLS + c] !== playerId) continue
      for (const [dr, dc] of WIN_DIRECTIONS) {
        let run = 1
        for (let k = 1; k < 4; k++) {
          const rr = r + dr * k
          const cc = c + dc * k
          if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) break
          if (board[rr * COLS + cc] !== playerId) break
          run++
        }
        if (run === 4) return true
      }
    }
  }
  return false
}

/** True when no empty cell remains (call only AFTER the win check). */
function isDraw(board: number[]): boolean {
  return board.every((cell) => cell !== 0)
}

/**
 * Settle RANK (TrueSkill + RP) **and stats** for a finished game exactly
 * once. Fire-and-forget: neither service throws and both return early without
 * a DB — the game outcome events are emitted regardless (games still play
 * when nothing can persist).
 *
 * A DRAW (full board) is settled as a real drawn outcome, not skipped: the
 * hidden skill update treats it as "these two are equal", and RP only drifts
 * toward skill by the gap — so a draw between evenly-rated players costs and
 * pays nothing, while a draw against someone far above you still nudges you
 * up. That is the whole point of the RP-chases-skill layer.
 *
 * Every ending funnels through here (win, draw, forfeit on leave, forfeit on
 * disconnect), so this single guard is what makes a Connect 4 result
 * un-double-recordable — including across a rematch, which deliberately
 * clears the flag so the NEW game settles on its own.
 */
function settleOnce(io: Server, game: ConnectGame, winner: ConnectWinner): void {
  if (game.eloSettled) return
  game.eloSettled = true
  const result = winner === 'draw' ? 'draw' : winner === 1 ? 'a' : 'b'
  const durationMs = Date.now() - game.startedAt

  // Fire-and-forget as before — nothing in the end path waits on the DB.
  // The settle result used to be discarded here (Connect's
  // `neonconnect_ended` payload has no ratings field in the client
  // contract); it is now kept just long enough to ride out on each
  // player's own `match:progression` event, alongside the XP award the
  // stats write produces. `game.gameId` is the SAME id the stats rows use,
  // so elo_history and match_results stay joinable (rankService drops
  // anything non-uuid).
  void (async () => {
    const settled = await settleRanked1v1(
      'connect',
      game.p1.wallet,
      game.p2.wallet,
      result,
      game.gameId
    )

    // STATS + PROGRESSION — one row per player. Connect 4 has no
    // kills/deaths/score, and the opponent field carries the registered
    // username only (never a wallet).
    await recordAndEmitProgression(io, 'connect', [
      {
        socketId: game.p1.socketId,
        ranked: settled?.a ?? null,
        input: {
          matchId: game.gameId, // randomUUID above — a valid uuid for the row
          wallet: game.p1.wallet,
          gameKey: 'connect',
          mode: '1v1',
          result: winner === 'draw' ? 'draw' : winner === 1 ? 'win' : 'loss',
          opponentUsername: game.p2.name,
          durationMs,
        },
      },
      {
        socketId: game.p2.socketId,
        ranked: settled?.b ?? null,
        input: {
          matchId: game.gameId,
          wallet: game.p2.wallet,
          gameKey: 'connect',
          mode: '1v1',
          result: winner === 'draw' ? 'draw' : winner === 2 ? 'win' : 'loss',
          opponentUsername: game.p1.name,
          durationMs,
        },
      },
    ])
  })()
}

/**
 * Mark a game terminal, announce the SERVER-decided result to the room, and
 * settle ELO. The game object survives (status 'ended') so the rematch
 * handshake can revive it; destruction happens on quit/disconnect.
 */
function finishGame(
  io: Server,
  game: ConnectGame,
  winner: ConnectWinner,
  reason: 'connect4' | 'draw'
): void {
  if (game.status === 'ended') return
  game.status = 'ended'
  game.winner = winner
  io.to(game.room).emit('neonconnect_ended', { winner, reason })
  settleOnce(io, game, winner)
}

/** Drop the game from every registry and pull both sockets out of the room. */
function destroyGame(io: Server, game: ConnectGame): void {
  for (const sid of [game.p1.socketId, game.p2.socketId]) {
    if (gameBySocket.get(sid) === game.gameId) gameBySocket.delete(sid)
    io.sockets.sockets.get(sid)?.leave(game.room)
  }
  games.delete(game.gameId)
}

/**
 * A player walked away from a FINISHED game without disconnecting (the
 * shared socket singleton stays up when they navigate back to the lobby and
 * re-queue). The abandoned opponent is told via neonconnect_opponent_quit —
 * same event a disconnect produces — and the dead game is torn down so
 * neither socket stays bound to it. Never called for ACTIVE games.
 *
 * The quit event goes to the OPPONENT ONLY — the abandoner is still in the
 * room (their socket never dropped), and the client treats this event as a
 * forfeit win, which would corrupt the abandoner's fresh searching state.
 */
function abandonEndedGame(
  io: Server,
  game: ConnectGame,
  abandonerSocketId: string
): void {
  const opponent =
    game.p1.socketId === abandonerSocketId ? game.p2 : game.p1
  io.to(opponent.socketId).emit('neonconnect_opponent_quit')
  destroyGame(io, game)
}

// ---------------------------------------------------------------------------
// MATCHMAKING — skill-based (rankingLogic.md §5.3)
// ---------------------------------------------------------------------------

/**
 * Try to start one game out of the waiting room.
 *
 * `pickSkillGroup` (socket/queue.ts) picks the pair with the smallest gap in
 * hidden skill that BOTH players are currently willing to accept — and the
 * width of "willing to accept" grows the longer you have waited, becoming
 * unbounded after ~30 seconds, so nobody is ever stuck waiting for a perfect
 * opponent who never arrives. Null means "no acceptable pair right now";
 * the caller keeps the players queued and the heartbeat re-checks.
 *
 * The pair comes back in FIFO order, which preserves the client contract:
 * the longest waiter is playerId 1 and moves first.
 *
 * Returns true when a game was started.
 */
function tryPair(io: Server, now: number = Date.now()): boolean {
  // Prune corpses first — a socket that vanished without a disconnect sweep
  // must not be picked as somebody's "closest opponent".
  removeFromQueue((e) => {
    const s = io.sockets.sockets.get(e.socketId)
    return s === undefined || s.disconnected
  })

  // PRIVATE PARTIES FIRST — a private room's pair matches itself, and only
  // itself; the public pool below never sees a party entry. A lone party
  // entry (partner's socket died between the dispatches) is released to the
  // public pool after the same grace the shared queue uses.
  let pair: ConnectQueueEntry[] | null = null
  const byParty = new Map<string, ConnectQueueEntry[]>()
  for (const entry of queue) {
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
    if (members.length >= NEEDED_PLAYERS) {
      pair = members.slice(0, NEEDED_PLAYERS)
      break
    }
  }
  if (!pair) {
    pair = pickSkillGroup(
      queue.filter((entry) => !entry.party),
      NEEDED_PLAYERS,
      now
    )
  }
  if (!pair) return false

  const [first, second] = pair
  const firstSocket = io.sockets.sockets.get(first.socketId)
  const secondSocket = io.sockets.sockets.get(second.socketId)
  if (!firstSocket || !secondSocket) return false // pruned above; belt-and-braces

  // Commit: both leave the queue before anything is emitted.
  removeFromQueue(
    (e) => e.socketId === first.socketId || e.socketId === second.socketId
  )

  // First-queued = playerId 1 and moves first (client contract).
  const gameId = randomUUID()
  const game: ConnectGame = {
    gameId,
    room: `connect-${gameId}`,
    p1: { socketId: first.socketId, wallet: first.wallet, name: first.name },
    p2: { socketId: second.socketId, wallet: second.wallet, name: second.name },
    board: new Array<number>(CELLS).fill(0),
    turn: 1,
    status: 'active',
    winner: null,
    resetRequested: { 1: false, 2: false },
    eloSettled: false,
    startedAt: Date.now(),
  }
  games.set(gameId, game)
  gameBySocket.set(game.p1.socketId, gameId)
  gameBySocket.set(game.p2.socketId, gameId)
  firstSocket.join(game.room)
  secondSocket.join(game.room)

  // Both players leave the queue at this instant — tell them so before the
  // match payload lands (the searching screens close on the match event).
  emitQueueStatus(firstSocket, false)
  emitQueueStatus(secondSocket, false)

  // Per-player payloads: each side learns its seat and whether it opens.
  // Names only — never wallets, and never the hidden skill we paired on.
  io.to(game.p1.socketId).emit('neonconnect_match', {
    opponent: game.p2.name,
    turn: true,
    playerId: 1,
  })
  io.to(game.p2.socketId).emit('neonconnect_match', {
    opponent: game.p1.name,
    turn: false,
    playerId: 2,
  })
  return true
}

/** Arm the anti-starvation re-check while two or more players are waiting. */
function scheduleRetry(io: Server): void {
  if (retryTimer) return
  if (queue.length < NEEDED_PLAYERS) return
  const timer = setTimeout(() => {
    retryTimer = null
    tryPair(io)
    scheduleRetry(io) // re-arm while a pairing is still theoretically possible
  }, MATCH_RETRY_MS)
  ;(timer as { unref?: () => void }).unref?.()
  retryTimer = timer
}

// ---------------------------------------------------------------------------
// registerConnect — wires all events + this module's OWN disconnect
// ---------------------------------------------------------------------------

export function registerConnect(io: Server, socket: Socket): void {
  // ----------------------------------------------------- neonconnect_join
  socket.on('neonconnect_join', async (payload: unknown) => {
    const parsed = joinSchema.safeParse(payload ?? {})
    if (!parsed.success) return

    const wallet = socket.data.wallet as string
    const username = (socket.data.username as string | null) ?? null

    // Games require a REGISTERED account — wallet-only sessions can't queue.
    if (!username) {
      socket.emit('gameAuthError', {
        code: 'no_account',
        message: 'Finish account setup to play online',
      })
      return
    }

    // Already bound to a game? Active → we do NOT re-queue them (that would
    // orphan a live match), but we must not answer with silence either: the
    // client is sitting on its optimistic "searching" screen, so resend the
    // seat it already owns and let it drop straight back into the board.
    // Ended → the player abandoned the rematch screen; release the old game,
    // then queue them normally.
    const bound = gameOf(socket.id)
    if (bound) {
      if (bound.status === 'active') {
        const seat = idOf(bound, socket.id)
        emitQueueStatus(socket, false) // not queued — already playing
        if (seat) {
          const opponent = seat === 1 ? bound.p2 : bound.p1
          socket.emit('neonconnect_match', {
            opponent: opponent.name,
            turn: bound.turn === seat,
            playerId: seat,
          })
        }
        return
      }
      abandonEndedGame(io, bound, socket.id)
    }

    // HIDDEN SKILL SNAPSHOT — taken before the entry exists so that
    // everything from "queued" to "paired" below stays synchronous (no await
    // window in which a disconnect could strand a half-built game). getSkill
    // never throws and always resolves: {MU_0, SIGMA_0} when there is no
    // users row or no database, so pairing degrades gracefully to "everyone
    // looks average" rather than failing.
    const skill = await getSkill(wallet, '1v1')
    if (socket.disconnected) return // gave up during the lookup — nobody to ack

    // The lookup was async: re-check that a CONCURRENT join (double click /
    // reconnect replay) didn't seat this socket in a live game while we
    // waited on the DB. Without this it could sit in the queue AND a game.
    const boundNow = gameOf(socket.id)
    if (boundNow && boundNow.status === 'active') {
      emitQueueStatus(socket, false)
      return
    }

    // One queue slot per wallet: re-emitting join REPLACES the old entry —
    // but it CARRIES THE ORIGINAL WAIT CLOCK FORWARD. A client that re-emits
    // neonconnect_join on every remount would otherwise keep resetting its
    // own acceptance window and could never widen out of a narrow skill band.
    const waitingSince =
      queue.find((e) => e.wallet === wallet)?.joinedAt ?? Date.now()
    removeFromQueue((e) => e.wallet === wallet)
    // PRIVATE PARTY: privateMatch.startRoom stamps the socket just before
    // re-driving this find (server-side only, TTL-checked). A party entry
    // takes a FRESH clock — inheriting a long public wait would trip the
    // grace demotion instantly and undo the protection.
    const stamp = socket.data.privateParty as
      | { id?: unknown; until?: unknown }
      | undefined
    const party =
      stamp &&
      typeof stamp.id === 'string' &&
      typeof stamp.until === 'number' &&
      stamp.until > Date.now()
        ? stamp.id
        : null
    queue.push({
      socketId: socket.id,
      wallet,
      name: username,
      mu: skill.mu,
      party,
      joinedAt: party ? Date.now() : waitingSince,
    })

    // Pair on SKILL, not arrival order. tryPair emits the match payloads (and
    // the inQueue:false status) itself for whoever it seats.
    tryPair(io)

    // Still waiting? Then ack the queue. The client already shows SEARCHING
    // FOR ONLINE MATCH on click, so this is confirmation rather than a
    // trigger — but it is sent EVERY time, re-joins included, so the UI can
    // never be left guessing. (Skill pairing can seat two OTHER players and
    // leave this one waiting, which this branch reports honestly.)
    if (queue.some((e) => e.socketId === socket.id)) {
      emitQueueStatus(socket, true)
    }
    scheduleRetry(io) // self-guards when fewer than two are left waiting
  })

  // ----------------------------------------------------- leaveConnectQueue
  socket.on('leaveConnectQueue', () => {
    // No payload by contract — nothing to validate. Idempotent: the client
    // fires this from the CANCEL button and again from its unmount cleanup,
    // and both must leave the wallet dequeued and acknowledged.
    removeFromQueue((e) => e.socketId === socket.id)
    emitQueueStatus(socket, false)
  })

  // ----------------------------------------------------- neonconnect_move
  socket.on('neonconnect_move', (payload: unknown) => {
    const parsed = moveSchema.safeParse(payload)
    if (!parsed.success) return

    const game = gameOf(socket.id)
    if (!game || game.status !== 'active') return

    const playerId = idOf(game, socket.id)
    if (!playerId) return // not a participant
    if (game.turn !== playerId) return // out-of-turn — the server board rules

    // Gravity: the disc lands in the LOWEST empty cell of the column.
    const col = parsed.data.col
    let row = -1
    for (let r = ROWS - 1; r >= 0; r--) {
      if (game.board[r * COLS + col] === 0) {
        row = r
        break
      }
    }
    if (row === -1) return // column full — illegal move, ignored

    game.board[row * COLS + col] = playerId

    // Relay to the OPPONENT ONLY before any end event, so their board shows
    // the final disc before the result lands.
    socket.to(game.room).emit('neonconnect_opponent_move', { col })

    // Terminal checks — the SERVER declares the result, not the clients.
    if (hasWon(game.board, playerId)) {
      finishGame(io, game, playerId, 'connect4')
    } else if (isDraw(game.board)) {
      finishGame(io, game, 'draw', 'draw')
    } else {
      game.turn = playerId === 1 ? 2 : 1
    }
  })

  // ---------------------------------------------------- neonconnect_reset
  socket.on('neonconnect_reset', () => {
    // No payload by contract. Rematch handshake — NOT the reference server's
    // blind relay: a single request relays NOTHING; the reset only happens
    // once BOTH players have asked.
    const game = gameOf(socket.id)
    if (!game || game.status !== 'ended') return // only a finished game

    const playerId = idOf(game, socket.id)
    if (!playerId) return

    game.resetRequested[playerId] = true
    if (!(game.resetRequested[1] && game.resetRequested[2])) return

    // Both agreed. First move of the rematch: the LOSER of the previous
    // game; after a draw, the previous player 2 (design contract).
    const firstTurn: PlayerId = game.winner === 1 ? 2 : game.winner === 2 ? 1 : 2

    game.board.fill(0)
    game.turn = firstTurn
    game.status = 'active'
    game.winner = null
    game.resetRequested[1] = false
    game.resetRequested[2] = false
    game.eloSettled = false // the rematch settles (and records) its own result
    game.startedAt = Date.now() // duration is per-game, not per-pairing

    // ROOM broadcast — BOTH clients clear their boards (requester included).
    // `turn` = the playerId that opens the rematch. `firstPlayer` is the SAME
    // value under the name the client reads (NeonConnectGame prefers an
    // explicit firstPlayer over its local derivation — keep both in sync).
    io.to(game.room).emit('neonconnect_reset', {
      turn: firstTurn,
      firstPlayer: firstTurn,
    })
  })

  // -------------------------------------------------------- neonconnect_leave
  // Voluntary exit (no payload). The shared socket singleton stays CONNECTED
  // when a player navigates back to the arcade, so without this event a
  // mid-game UI quit would never reach the server and the opponent would hang
  // until the leaver closed the tab. Semantics mirror `disconnect` exactly —
  // active game = forfeit, opponent wins, ELO settles once — except the quit
  // notice goes to the OPPONENT ONLY (the leaver is still in the room, and
  // the client treats neonconnect_opponent_quit as a forfeit win).
  socket.on('neonconnect_leave', () => {
    removeFromQueue((e) => e.socketId === socket.id)

    const game = gameOf(socket.id)
    if (!game) return

    const playerId = idOf(game, socket.id)
    const opponent = game.p1.socketId === socket.id ? game.p2 : game.p1
    io.to(opponent.socketId).emit('neonconnect_opponent_quit')

    if (game.status === 'active' && playerId) {
      game.status = 'ended'
      game.winner = playerId === 1 ? 2 : 1
      // The SERVER-declared result, not just the bare quit signal: the
      // survivor's client renders the same authoritative end every other
      // finish gets, with the reason attached ("opponent left — you win").
      // Opponent only — the leaver is mid-navigation to a fresh lobby and
      // an ended event would corrupt that state (same rule as the quit
      // event above).
      io.to(opponent.socketId).emit('neonconnect_ended', {
        winner: game.winner,
        reason: 'forfeit',
      })
      settleOnce(io, game, game.winner)
    }

    destroyGame(io, game) // also clears both gameBySocket bindings
  })

  // ------------------------------------------------------------ disconnect
  // Per-module cleanup (design contract: no central disconnect loop).
  socket.on('disconnect', () => {
    removeFromQueue((e) => e.socketId === socket.id)

    const game = gameOf(socket.id)
    gameBySocket.delete(socket.id)
    if (!game) return

    const playerId = idOf(game, socket.id)

    // The survivor learns the opponent is gone whatever the game phase —
    // the client awards itself the win locally on this event.
    io.to(game.room).emit('neonconnect_opponent_quit')

    // Mid-game quit forfeits: the opponent wins and ELO settles exactly
    // ONCE (settleOnce guard). A game already 'ended' was settled when it
    // finished — nothing more to pay out here. The room emit is safe: the
    // disconnected socket has already left it, so only the survivor hears
    // the authoritative forfeit result.
    if (game.status === 'active' && playerId) {
      game.status = 'ended'
      game.winner = playerId === 1 ? 2 : 1
      io.to(game.room).emit('neonconnect_ended', {
        winner: game.winner,
        reason: 'forfeit',
      })
      settleOnce(io, game, game.winner)
    }

    destroyGame(io, game)
  })
}
