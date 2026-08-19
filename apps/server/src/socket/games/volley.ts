/**
 * NEON VOLLEY (ping pong) — registerVolley(io, socket)
 * ====================================================
 * Server-authoritative 1v1 pong. The multiplayer client renders ONLY what
 * the server streams (`volleyUpdate` every tick) — its local physics loop is
 * a deliberate no-op — so this module simulates ball movement, wall/paddle
 * collisions and scoring, using the CLIENT's constants (pinned to
 * apps/web/src/components/Volley/PingPongGame.tsx:19-28 per the design
 * contract; where the old reference server disagreed, the client wins).
 *
 * Flow:
 *   findVolleyGame { matchMode, avatarUrl? }
 *     → shared per-matchMode SKILL queue (socket/queue.ts) → ALWAYS answers
 *       with 'queue:status' + the legacy 'waiting' ack, duplicates included
 *     → on pair: room `volley-${gameId}` + 'volleyGameStart' to both,
 *       physics starts after a 3000ms grace (client runs a local 3s
 *       countdown before it renders the rally)
 *   movePaddle { gameId, paddleY }   — side derived from socket.id, clamped
 *   volleyResign(gameId)             — bare string payload (legacy client)
 *   volleyRequestRematch(gameId)     — two-sided handshake → volleyGameReset
 *   leaveVolleyQueue                 — no payload, drops all queue slots
 *
 * Matchmaking lives in socket/queue.ts now. The old local per-mode queues went
 * SILENT whenever a wallet that was already queued re-sent findVolleyGame (the
 * "one slot per wallet, replace" path just returned), so every search after the
 * first produced no server reply at all and the client froze on the lobby.
 *
 * Identity: ALWAYS socket.data.wallet / socket.data.username (handshake
 * auth). Payload names are ignored; avatarUrl is cosmetic passthrough.
 * Wallets are NEVER included in anything emitted to the room.
 *
 * RANK: rankService.settleRanked1v1('volley', ...) exactly once per finished
 * game on the '1v1' ladder, funneled through endGame() (status flip guards
 * double-settlement — the reference server's central disconnect loop
 * double-applied ELO; each module now owns its own disconnect cleanup).
 * Matchmaking pairs on HIDDEN skill (see the `ladder` option below), so a
 * rally is between two players the model thinks are evenly matched.
 */

import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import { settleRanked1v1 } from '../../services/rankService'
// eloService is now just the wire projection (strips wallet/mu/sigma).
import { publicRating, type PublicRating } from '../../services/eloService'
// Stats are written from the same endGame() funnel, under the same
// `eloSettled` guard, so a rally can only ever be recorded once.
import { recordAndEmitProgression } from './progression'
// Shared, idempotent, never-silent matchmaking queue.
import {
  joinQueue,
  leaveQueue as leaveSharedQueue,
  attachQueueCleanup,
  QUEUE_STATUS_EVENT,
  type QueueMatch,
} from '../queue'

// ---------------------------------------------------------------------------
// Physics constants — MUST match the client (PingPongGame.tsx:19-28).
// ---------------------------------------------------------------------------
const CANVAS_WIDTH = 1000
const CANVAS_HEIGHT = 500
const PADDLE_WIDTH = 8
const PADDLE_HEIGHT = 60
const PADDLE_OFFSET = 30 // paddle distance from its wall
const BALL_SIZE = 12
const BORDER_OFFSET = 12 // neon border inset; also the paddle travel limit
const START_SPEED = 5
const SPEED_INC = 1.08 // +8% per paddle hit
const MAX_SPEED = 18

// The client's single-player loop bounces the ball off walls inset by
// BORDER_OFFSET + 4 (its `effectiveBorder`) — mirror that exactly so the
// multiplayer rally looks identical to practice mode.
const WALL_INSET = BORDER_OFFSET + 4

// Paddle Y travel range (client clamps its own emits the same way, but we
// never trust the payload): [12, 500 - 12 - 60] = [12, 428].
const PADDLE_MIN_Y = BORDER_OFFSET
const PADDLE_MAX_Y = CANVAS_HEIGHT - BORDER_OFFSET - PADDLE_HEIGHT

const TICK_MS = 32 // ~30fps broadcast + simulation cadence
const START_GRACE_MS = 3000 // client runs a local 3s countdown after start
const RESET_GRACE_MS = 500 // volleyGameReset jumps straight to 'playing'

// First-to-N per regulation (client computes the same locally).
const WIN_SCORES = { classic: 11, bestof3: 2, sudden: 1 } as const
type MatchMode = keyof typeof WIN_SCORES

// Queue coordinates: one sub-queue per regulation, but only ONE slot per
// wallet across all of them (enforced inside socket/queue.ts).
const VOLLEY_GAME = 'volley'
const VOLLEY_PLAYERS_NEEDED = 2

// ---------------------------------------------------------------------------
// Types + module state
// ---------------------------------------------------------------------------

/** What we know about a player. `wallet` is server-side only — never emit. */
interface VolleyPlayer {
  socketId: string
  wallet: string
  name: string
  avatarUrl: string
}

/** Wallet-free view of a player, safe to broadcast to the room. */
interface PublicPlayer {
  socketId: string
  name: string
  avatarUrl: string
}

interface Vec2 {
  x: number
  y: number
}

interface VolleyGame {
  gameId: string
  room: string // `volley-${gameId}`
  matchMode: MatchMode
  status: 'active' | 'ended'
  p1: VolleyPlayer // first-queued = left paddle
  p2: VolleyPlayer // joiner = right paddle
  score: { p1: number; p2: number }
  ballPos: Vec2
  ballVel: Vec2
  paddle1Y: number
  paddle2Y: number
  /** Physics is frozen (ball parked at center) until this timestamp — the
   *  countdown grace after start/rematch. Broadcasts still run so paddle
   *  movement stays live during the countdown. */
  physicsResumeAt: number
  /** THE interval handle lives on the game object (design rule) so it can
   *  always be cleared before a new loop starts — no stacked intervals. */
  interval: ReturnType<typeof setInterval> | null
  /** Guards rankService.settleRanked1v1 AND the stats write to exactly one
   *  call per finished game (a rematch clears it — the new game settles its
   *  own). Name kept for continuity; it now guards an RP settlement. */
  eloSettled: boolean
  /** Wall-clock start of the CURRENT game, for match_results.durationMs. */
  startedAt: number
  rematchRequested: { p1: boolean; p2: boolean }
}

// All live volley games, keyed by gameId (the uuid the client echoes back).
const games = new Map<string, VolleyGame>()

/** Extras carried through the shared queue (cosmetic only). */
interface VolleyMeta {
  avatarUrl: string
}

// ---------------------------------------------------------------------------
// Zod payload schemas — EVERY event payload is safeParse'd (global rule);
// failures are silently ignored and only parsed.data is ever used.
// ---------------------------------------------------------------------------

const findVolleyGameSchema = z.object({
  // Client always sends one of the three; default to classic like the ref
  // server did if the field is simply absent.
  matchMode: z.enum(['classic', 'bestof3', 'sudden']).optional().default('classic'),
  // Cosmetic only — display name comes from socket.data.username, never
  // from the payload (identity rule). Length-capped to stop abuse.
  avatarUrl: z.string().max(500).optional(),
})

const movePaddleSchema = z.object({
  gameId: z.string().min(1).max(64),
  paddleY: z.number().finite(),
  // NOTE: the client also sends `player: 'p1'|'p2'` — deliberately NOT in
  // the schema. The paddle side is derived from socket.id (design rule:
  // never trust the self-declared slot).
})

// volleyResign / volleyRequestRematch send a BARE gameId string (legacy
// client shape) — validate it as such.
const gameIdSchema = z.string().min(1).max(64)

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Wallet-stripped player view for room payloads. */
function toPublic(p: VolleyPlayer): PublicPlayer {
  return { socketId: p.socketId, name: p.name, avatarUrl: p.avatarUrl }
}

/** Serializable, wallet-free snapshot of a game — used for volleyGameReset
 *  ("full game object" per design, minus wallets + the interval handle). */
function publicGameState(game: VolleyGame) {
  return {
    gameId: game.gameId,
    matchMode: game.matchMode,
    status: game.status,
    p1: toPublic(game.p1),
    p2: toPublic(game.p2),
    score: game.score,
    ballPos: game.ballPos,
    ballVel: game.ballVel,
    paddle1Y: game.paddle1Y,
    paddle2Y: game.paddle2Y,
  }
}

/** Is this socket currently a player in a LIVE volley game? Guards against a
 *  duplicate findVolleyGame putting an in-match socket back into the queue. */
function isPlayingVolley(socketId: string): boolean {
  for (const game of games.values()) {
    if (game.status !== 'active') continue
    if (game.p1.socketId === socketId || game.p2.socketId === socketId) return true
  }
  return false
}

/** Center the ball and serve in a random diagonal — mirrors the client's
 *  resetBall(): x = ±START_SPEED, y = ±START_SPEED*0.8 (so ±5 / ±4). */
function resetBall(game: VolleyGame) {
  game.ballPos = { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 }
  game.ballVel = {
    x: (Math.random() > 0.5 ? 1 : -1) * START_SPEED,
    y: (Math.random() > 0.5 ? 1 : -1) * (START_SPEED * 0.8),
  }
}

// ---------------------------------------------------------------------------
// Physics — a straight port of the client's single-player update() so both
// modes feel identical (PingPongGame.tsx:188-258).
// ---------------------------------------------------------------------------

/** Advance one tick. Returns the winning side if this tick ended the match. */
function stepPhysics(game: VolleyGame): 'p1' | 'p2' | null {
  const { ballPos, ballVel } = game

  ballPos.x += ballVel.x
  ballPos.y += ballVel.y

  // Wall collisions (top/bottom, inset like the client's effectiveBorder).
  if (ballPos.y <= WALL_INSET) {
    ballVel.y = Math.abs(ballVel.y)
    ballPos.y = WALL_INSET
  } else if (ballPos.y >= CANVAS_HEIGHT - BALL_SIZE - WALL_INSET) {
    ballVel.y = -Math.abs(ballVel.y)
    ballPos.y = CANVAS_HEIGHT - BALL_SIZE - WALL_INSET
  }

  // Left paddle (p1) — bounce, speed up 8% (capped), add spin from where the
  // ball struck the paddle, then snap the ball out of the paddle. The cap is
  // applied BEFORE the spin term, exactly like the client.
  if (ballPos.x <= PADDLE_OFFSET + PADDLE_WIDTH) {
    if (ballPos.y + BALL_SIZE >= game.paddle1Y && ballPos.y <= game.paddle1Y + PADDLE_HEIGHT) {
      ballVel.x = Math.abs(ballVel.x) * SPEED_INC
      ballVel.y *= SPEED_INC
      if (Math.abs(ballVel.x) > MAX_SPEED) ballVel.x = Math.sign(ballVel.x) * MAX_SPEED
      if (Math.abs(ballVel.y) > MAX_SPEED) ballVel.y = Math.sign(ballVel.y) * MAX_SPEED
      const deltaY = ballPos.y - (game.paddle1Y + PADDLE_HEIGHT / 2)
      ballVel.y += deltaY * 0.2
      ballPos.x = PADDLE_OFFSET + PADDLE_WIDTH
    } else if (ballPos.x < 0) {
      game.score.p2 += 1
      resetBall(game)
    }
  }

  // Right paddle (p2) — mirror image of the left side.
  if (ballPos.x >= CANVAS_WIDTH - PADDLE_WIDTH - BALL_SIZE - PADDLE_OFFSET) {
    if (ballPos.y + BALL_SIZE >= game.paddle2Y && ballPos.y <= game.paddle2Y + PADDLE_HEIGHT) {
      ballVel.x = -Math.abs(ballVel.x) * SPEED_INC
      ballVel.y *= SPEED_INC
      if (Math.abs(ballVel.x) > MAX_SPEED) ballVel.x = Math.sign(ballVel.x) * MAX_SPEED
      if (Math.abs(ballVel.y) > MAX_SPEED) ballVel.y = Math.sign(ballVel.y) * MAX_SPEED
      const deltaY = ballPos.y - (game.paddle2Y + PADDLE_HEIGHT / 2)
      ballVel.y += deltaY * 0.2
      ballPos.x = CANVAS_WIDTH - PADDLE_WIDTH - BALL_SIZE - PADDLE_OFFSET
    } else if (ballPos.x > CANVAS_WIDTH) {
      game.score.p1 += 1
      resetBall(game)
    }
  }

  // Win check — first to the regulation score for this matchMode.
  const winScore = WIN_SCORES[game.matchMode]
  if (game.score.p1 >= winScore) return 'p1'
  if (game.score.p2 >= winScore) return 'p2'
  return null
}

/**
 * Start (or restart) the 32ms simulation/broadcast loop for a game.
 * Always clears any existing interval first — the handle lives ON the game
 * object precisely so loops can never stack (design rule).
 */
function startPhysicsLoop(io: Server, game: VolleyGame) {
  if (game.interval) {
    clearInterval(game.interval)
    game.interval = null
  }

  game.interval = setInterval(() => {
    // Safety net: if the game ended through another path (resign/disconnect)
    // endGame already cleared this interval — but guard anyway.
    if (game.status !== 'ended') {
      // Freeze the ball during the countdown grace; paddles stay live.
      if (Date.now() >= game.physicsResumeAt) {
        const winnerSide = stepPhysics(game)
        if (winnerSide) {
          // endGame clears this interval, settles ELO once and emits
          // volleyEnded. Fire-and-forget — never block the timer callback.
          void endGame(io, game, winnerSide, 'match_complete')
        }
      }
      io.to(game.room).emit('volleyUpdate', {
        ballPos: game.ballPos,
        paddle1Y: game.paddle1Y,
        paddle2Y: game.paddle2Y,
        score: game.score,
      })
    }
  }, TICK_MS)
}

/**
 * SINGLE funnel for every way a game can end (match complete, resignation,
 * disconnect). The synchronous status flip at the top makes this idempotent:
 * whichever path gets here first wins, and ELO is settled exactly once.
 */
async function endGame(
  io: Server,
  game: VolleyGame,
  winnerSide: 'p1' | 'p2',
  reason: 'match_complete' | 'resignation' | 'disconnect',
  details?: string
) {
  if (game.status === 'ended') return
  game.status = 'ended'

  if (game.interval) {
    clearInterval(game.interval)
    game.interval = null
  }

  // Settle ratings ONCE. settleRanked1v1 returns null when there is no DB
  // (games still play, ratings just don't move) — the payload carries null.
  let newRatings: { p1: PublicRating; p2: PublicRating } | null = null
  if (!game.eloSettled) {
    game.eloSettled = true
    // p1 is always passed as "a", p2 as "b" — keep the mapping in one place.
    // Volley has no draw: a rally always reaches the regulation score, and a
    // resignation/disconnect is a decisive loss for the player who left.
    const settled = await settleRanked1v1(
      'volley',
      game.p1.wallet,
      game.p2.wallet,
      winnerSide === 'p1' ? 'a' : 'b',
      // SAME match id as the stats rows below → elo_history and
      // match_results are joinable. Non-uuids are dropped by rankService.
      game.gameId
    )
    // publicRating drops wallet/mu/sigma before this ever touches the room.
    if (settled) {
      newRatings = { p1: publicRating(settled.a), p2: publicRating(settled.b) }
    }

    // STATS + PROGRESSION — one row per player. Volley has no kills/deaths;
    // `score` is the player's own rally score, and `mode` is the regulation
    // (classic / bestof3 / sudden) so per-mode win rates stay separable. The
    // opponent field is the registered username only (never a wallet). Same
    // stats write as before, but each player's XP award and own settle
    // result now ride out on `match:progression` (games/progression.ts).
    const durationMs = Date.now() - game.startedAt
    void recordAndEmitProgression(io, 'volley', [
      {
        socketId: game.p1.socketId,
        ranked: settled?.a ?? null,
        input: {
          matchId: game.gameId, // queue matchId (uuid); non-uuids are dropped
          wallet: game.p1.wallet,
          gameKey: 'volley',
          mode: game.matchMode,
          result: winnerSide === 'p1' ? 'win' : 'loss',
          score: game.score.p1,
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
          gameKey: 'volley',
          mode: game.matchMode,
          result: winnerSide === 'p2' ? 'win' : 'loss',
          score: game.score.p2,
          opponentUsername: game.p1.name,
          durationMs,
        },
      },
    ])
  }

  const winner = winnerSide === 'p1' ? game.p1 : game.p2
  io.to(game.room).emit('volleyEnded', {
    winner: winner.name, // legacy clients compare by name...
    winnerSocketId: winner.socketId, // ...new clients prefer the socket id
    reason,
    ...(details ? { details } : {}),
    score: game.score,
    newRatings,
  })
  // NOTE: the game object stays in the registry after a normal end — the
  // rematch handshake needs it. Disconnect cleanup deletes it instead.
}

// ---------------------------------------------------------------------------
// Match handoff — the shared queue calls this with exactly two CONNECTED
// players that are already joined to `match.room` (`volley-${matchId}`).
// Fully synchronous: no await can open a window between "paired" and "the game
// exists", so a disconnect during setup is impossible.
// ---------------------------------------------------------------------------
function startVolleyMatch(match: QueueMatch<VolleyMeta>): void {
  const { io, room, matchId, players, mode } = match
  // `mode` is the queue key, which for volley IS the regulation. It came from
  // a zod-validated payload, but re-narrow defensively before indexing.
  const matchMode: MatchMode = mode in WIN_SCORES ? (mode as MatchMode) : 'classic'

  const toVolleyPlayer = (p: (typeof players)[number]): VolleyPlayer => ({
    socketId: p.socketId,
    wallet: p.wallet,
    name: p.username, // canonical handshake username — payloads never trusted
    avatarUrl:
      p.meta?.avatarUrl ??
      `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(p.username)}`,
  })

  // FIFO: players[0] waited the longest → p1 → LEFT paddle (unchanged rule).
  const game: VolleyGame = {
    gameId: matchId,
    room,
    matchMode,
    status: 'active',
    p1: toVolleyPlayer(players[0]),
    p2: toVolleyPlayer(players[1]),
    score: { p1: 0, p2: 0 },
    ballPos: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 }, // center 500,250
    ballVel: { x: START_SPEED, y: START_SPEED * 0.8 }, // randomized below
    paddle1Y: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2, // 220, client default
    paddle2Y: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
    physicsResumeAt: Date.now() + START_GRACE_MS, // client's 3s countdown
    interval: null,
    eloSettled: false,
    startedAt: Date.now(),
    rematchRequested: { p1: false, p2: false },
  }
  resetBall(game) // randomize the opening serve direction
  games.set(game.gameId, game)

  // Client contract: both players get the same start payload and derive their
  // side from p1.socketId === socket.id. No wallets in here.
  io.to(room).emit('volleyGameStart', {
    gameId: game.gameId,
    p1: toPublic(game.p1),
    p2: toPublic(game.p2),
    matchMode: game.matchMode,
    score: game.score,
    ballPos: game.ballPos,
    ballVel: game.ballVel,
    paddle1Y: game.paddle1Y,
    paddle2Y: game.paddle2Y,
  })

  startPhysicsLoop(io, game)
}

// ---------------------------------------------------------------------------
// registerVolley — wires this socket's volley events + its own disconnect
// cleanup (no central disconnect loop; see socket/index.ts header).
// ---------------------------------------------------------------------------
export function registerVolley(io: Server, socket: Socket) {
  // -------------------------------------------------------------------------
  // Matchmaking
  // -------------------------------------------------------------------------
  // Queue cleanup on disconnect is owned by the shared queue module (safe to
  // attach more than once — it de-dupes per socket).
  attachQueueCleanup(socket, io)

  // ALWAYS answers: joinQueue emits `queue:status` + the legacy `waiting` ack
  // on EVERY call, including a re-search from a wallet that is already queued.
  socket.on('findVolleyGame', async (payload) => {
    const parsed = findVolleyGameSchema.safeParse(payload)
    if (!parsed.success) return // silently ignore malformed payloads

    const { matchMode } = parsed.data
    const username: string | null | undefined = socket.data.username

    // Already rallying → don't queue this socket a second time. Answer anyway
    // (never silent) so an optimistic client can drop a stray spinner.
    if (isPlayingVolley(socket.id)) {
      socket.emit(QUEUE_STATUS_EVENT, {
        game: VOLLEY_GAME,
        mode: matchMode,
        inQueue: false,
        current: 0,
        needed: VOLLEY_PLAYERS_NEEDED,
      })
      return
    }

    await joinQueue<VolleyMeta>({
      socket,
      io,
      game: VOLLEY_GAME,
      // One sub-queue per regulation; one slot per wallet across all of them.
      mode: matchMode,
      needed: VOLLEY_PLAYERS_NEEDED,
      // §5.3: pair on hidden skill from the '1v1' pool. Every regulation
      // shares that pool — a rally is a rally, whatever the target score.
      ladder: '1v1',
      meta: {
        avatarUrl:
          parsed.data.avatarUrl ??
          `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username ?? 'Player')}`,
      },
      // Pre-existing clients still key off `waiting`; both events go out.
      legacyAck: { event: 'waiting', payload: 'Searching for online match...' },
      onMatch: startVolleyMatch,
    })
  })

  // Explicit queue exit ("Cancel" / unmount / view change) — no payload.
  // Idempotent and never silent, so cancel always resolves the client's UI.
  socket.on('leaveVolleyQueue', () => {
    leaveSharedQueue({ socket, io, game: VOLLEY_GAME }) // every regulation
  })

  // -------------------------------------------------------------------------
  // Gameplay
  // -------------------------------------------------------------------------
  socket.on('movePaddle', (payload) => {
    const parsed = movePaddleSchema.safeParse(payload)
    if (!parsed.success) return

    const game = games.get(parsed.data.gameId)
    if (!game || game.status !== 'active') return

    // Derive WHICH paddle from the sender's socket id — the client's
    // self-declared 'player' field is ignored (never trust the slot).
    const clamped = Math.max(PADDLE_MIN_Y, Math.min(PADDLE_MAX_Y, parsed.data.paddleY))
    if (socket.id === game.p1.socketId) {
      game.paddle1Y = clamped
    } else if (socket.id === game.p2.socketId) {
      game.paddle2Y = clamped
    }
    // Non-participants fall through silently.
  })

  socket.on('volleyResign', (payload) => {
    const parsed = gameIdSchema.safeParse(payload) // bare gameId string
    if (!parsed.success) return

    const game = games.get(parsed.data)
    if (!game || game.status !== 'active') return

    // Only a participant can resign; the OTHER player wins.
    let winnerSide: 'p1' | 'p2'
    if (socket.id === game.p1.socketId) winnerSide = 'p2'
    else if (socket.id === game.p2.socketId) winnerSide = 'p1'
    else return

    void endGame(io, game, winnerSide, 'resignation')
  })

  // -------------------------------------------------------------------------
  // Rematch — two-sided handshake. First requester flags their side and the
  // opponent sees 'rematchOffered'; when BOTH sides have requested, the game
  // resets in place and the loop restarts (500ms grace — the client skips
  // its countdown on volleyGameReset and jumps straight to 'playing').
  // -------------------------------------------------------------------------
  socket.on('volleyRequestRematch', (payload) => {
    const parsed = gameIdSchema.safeParse(payload) // bare gameId string
    if (!parsed.success) return

    const game = games.get(parsed.data)
    if (!game || game.status !== 'ended') return

    if (socket.id === game.p1.socketId) game.rematchRequested.p1 = true
    else if (socket.id === game.p2.socketId) game.rematchRequested.p2 = true
    else return // not a participant

    if (!(game.rematchRequested.p1 && game.rematchRequested.p2)) {
      // Only one side so far — nudge the other player.
      socket.to(game.room).emit('rematchOffered')
      return
    }

    // Both agreed — fresh match on the same game object/room.
    game.status = 'active'
    game.score = { p1: 0, p2: 0 }
    game.paddle1Y = CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2
    game.paddle2Y = CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2
    game.rematchRequested = { p1: false, p2: false }
    game.eloSettled = false // the NEW game gets its own settlement + stats row
    game.startedAt = Date.now() // duration is per-game, not per-pairing
    game.physicsResumeAt = Date.now() + RESET_GRACE_MS
    resetBall(game)

    // "Full game object" per design — wallet-free, interval-free snapshot.
    io.to(game.room).emit('volleyGameReset', publicGameState(game))
    startPhysicsLoop(io, game)
  })

  // -------------------------------------------------------------------------
  // Disconnect cleanup — this module's OWN games/queues only.
  // -------------------------------------------------------------------------
  socket.on('disconnect', () => {
    // Queue slots are dropped by the shared queue's own disconnect listener
    // (keyed by socket.id, so an old tab closing can't evict a live second
    // session of the same wallet). This handler only owns live games.

    // Sweep games this socket was playing in.
    for (const [gameId, game] of games) {
      const isP1 = socket.id === game.p1.socketId
      const isP2 = socket.id === game.p2.socketId
      if (!isP1 && !isP2) continue

      if (game.status === 'active') {
        // Mid-game disconnect: the survivor wins, ELO settles once, room
        // gets exactly one volleyEnded, loop stops — then the game dies
        // (no rematch possible against a vanished opponent).
        void endGame(io, game, isP1 ? 'p2' : 'p1', 'disconnect', 'Opponent disconnected')
      } else if (game.interval) {
        // Ended games should have no loop, but never leak a timer.
        clearInterval(game.interval)
        game.interval = null
      }
      // Either way the game object is gone now — an ended game awaiting a
      // rematch is silently discarded (the remaining player's rematch
      // request will simply find no game, which the client treats as inert).
      games.delete(gameId)
    }
  })
}
