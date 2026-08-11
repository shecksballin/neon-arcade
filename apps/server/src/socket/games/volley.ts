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
 *     → per-matchMode FIFO queue → 'waiting'
 *     → on pair: room `volley-${gameId}` + 'volleyGameStart' to both,
 *       physics starts after a 3000ms grace (client runs a local 3s
 *       countdown before it renders the rally)
 *   movePaddle { gameId, paddleY }   — side derived from socket.id, clamped
 *   volleyResign(gameId)             — bare string payload (legacy client)
 *   volleyRequestRematch(gameId)     — two-sided handshake → volleyGameReset
 *   leaveVolleyQueue                 — no payload, drops all queue slots
 *
 * Identity: ALWAYS socket.data.wallet / socket.data.username (handshake
 * auth). Payload names are ignored; avatarUrl is cosmetic passthrough.
 * Wallets are NEVER included in anything emitted to the room.
 *
 * ELO: eloService.settle1v1('volley', ...) exactly once per finished game,
 * funneled through endGame() (status flip guards double-settlement — the
 * reference server's central disconnect loop double-applied ELO; each
 * module now owns its own disconnect cleanup instead).
 */

import { randomUUID } from 'node:crypto'
import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import { settle1v1 } from '../../services/eloService'

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
  /** Guards eloService.settle1v1 to exactly one call per finished game. */
  eloSettled: boolean
  rematchRequested: { p1: boolean; p2: boolean }
}

// One FIFO queue per matchMode (design: volley queues are per-mode).
const queues = new Map<MatchMode, VolleyPlayer[]>()

// All live volley games, keyed by gameId (the uuid the client echoes back).
const games = new Map<string, VolleyGame>()

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

/** Remove every queue entry belonging to `wallet` (a wallet may hold at most
 *  ONE volley queue slot across all modes — re-queueing replaces it). */
function removeFromQueues(wallet: string) {
  for (const [mode, queue] of queues) {
    queues.set(
      mode,
      queue.filter((entry) => entry.wallet !== wallet)
    )
  }
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

  // Settle ratings ONCE. settle1v1 returns null when there is no DB (games
  // still play, ratings just don't move) — the payload carries null then.
  let newRatings: {
    p1: { name: string; rating: number; change: number }
    p2: { name: string; rating: number; change: number }
  } | null = null
  if (!game.eloSettled) {
    game.eloSettled = true
    // p1 is always passed as "a", p2 as "b" — keep the mapping in one place.
    const settled = await settle1v1(
      'volley',
      game.p1.wallet,
      game.p2.wallet,
      winnerSide === 'p1' ? 'a' : 'b'
    )
    if (settled) newRatings = { p1: settled.a, p2: settled.b }
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
// registerVolley — wires this socket's volley events + its own disconnect
// cleanup (no central disconnect loop; see socket/index.ts header).
// ---------------------------------------------------------------------------
export function registerVolley(io: Server, socket: Socket) {
  // -------------------------------------------------------------------------
  // Matchmaking
  // -------------------------------------------------------------------------
  socket.on('findVolleyGame', (payload) => {
    const parsed = findVolleyGameSchema.safeParse(payload)
    if (!parsed.success) return // silently ignore malformed payloads

    // Games require a registered account (username) — the wallet alone is
    // not enough (design: gameAuthError { code: 'no_account' }).
    const wallet: string | undefined = socket.data.wallet
    const username: string | null | undefined = socket.data.username
    if (!wallet) return // can't happen behind socketAuth, but never trust it
    if (!username) {
      socket.emit('gameAuthError', {
        code: 'no_account',
        message: 'Finish account setup to play online',
      })
      return
    }

    const { matchMode } = parsed.data
    const player: VolleyPlayer = {
      socketId: socket.id,
      wallet,
      name: username, // canonical name — payload names are ignored
      avatarUrl:
        parsed.data.avatarUrl ??
        `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`,
    }

    // One queue slot per wallet across ALL volley modes — re-emitting
    // findVolleyGame (any mode) replaces the old entry.
    removeFromQueues(wallet)

    let queue = queues.get(matchMode)
    if (!queue) {
      queue = []
      queues.set(matchMode, queue)
    }

    // FIFO: pair with the LONGEST-waiting player (shift, not the ref's pop).
    // Skip entries whose socket has vanished (stale disconnects).
    let opponent: VolleyPlayer | undefined
    let opponentSocket: Socket | undefined
    while (queue.length > 0) {
      const candidate = queue.shift()!
      const candidateSocket = io.sockets.sockets.get(candidate.socketId)
      if (candidateSocket) {
        opponent = candidate
        opponentSocket = candidateSocket
        break
      }
    }

    if (!opponent || !opponentSocket) {
      // Nobody waiting — take the slot and hold.
      queue.push(player)
      socket.emit('waiting', 'Scanning for volley signal...')
      return
    }

    // ------------------------------------------------------------------
    // Pair found — build the game. p1 = first-queued = LEFT paddle.
    // ------------------------------------------------------------------
    const gameId = randomUUID()
    const room = `volley-${gameId}`
    const game: VolleyGame = {
      gameId,
      room,
      matchMode,
      status: 'active',
      p1: opponent,
      p2: player,
      score: { p1: 0, p2: 0 },
      ballPos: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 }, // center 500,250
      ballVel: { x: START_SPEED, y: START_SPEED * 0.8 }, // randomized below
      paddle1Y: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2, // 220, client default
      paddle2Y: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
      physicsResumeAt: Date.now() + START_GRACE_MS, // client's 3s countdown
      interval: null,
      eloSettled: false,
      rematchRequested: { p1: false, p2: false },
    }
    resetBall(game) // randomize the opening serve direction
    games.set(gameId, game)

    socket.join(room)
    opponentSocket.join(room)

    // Client contract: both players get the same start payload and derive
    // their side from p1.socketId === socket.id. No wallets in here.
    io.to(room).emit('volleyGameStart', {
      gameId,
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
  })

  // Explicit queue exit ("Abort Uplink") — no payload.
  socket.on('leaveVolleyQueue', () => {
    const wallet: string | undefined = socket.data.wallet
    if (wallet) removeFromQueues(wallet)
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
    game.eloSettled = false // the NEW game gets its own settlement
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
    // Drop any queue slots held by this socket. Keyed by socketId (not
    // wallet) so a second live session of the same wallet isn't evicted by
    // an old tab closing.
    for (const [mode, queue] of queues) {
      queues.set(
        mode,
        queue.filter((entry) => entry.socketId !== socket.id)
      )
    }

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
