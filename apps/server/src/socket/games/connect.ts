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
 *   C→S  neonconnect_join { profile }     — enter the FIFO queue
 *   C→S  leaveConnectQueue                — NEW: leave the queue (no payload)
 *   C→S  neonconnect_move { col }         — drop a disc in column 0..6
 *   C→S  neonconnect_reset                — request a rematch (handshake)
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
import { settle1v1 } from '../../services/eloService'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROWS = 6
const COLS = 7
const CELLS = ROWS * COLS // 42

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
  wallet: string // NEVER emitted — pairing rules + ELO only
  name: string // canonical: socket.data.username
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
  eloSettled: boolean // exactly-once guard around eloService.settle1v1
}

// FIFO queue (shift(), not the reference server's LIFO pop()).
const queue: ConnectPlayer[] = []
// gameId → game, plus a socket.id → gameId index for O(1) lookups.
const games = new Map<string, ConnectGame>()
const gameBySocket = new Map<string, string>()

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
function removeFromQueue(match: (entry: ConnectPlayer) => boolean): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (match(queue[i])) queue.splice(i, 1)
  }
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
 * Settle ELO for a finished game exactly once. Fire-and-forget: eloService
 * never throws and returns null without a DB — the game outcome events are
 * emitted regardless (games still play when ratings can't persist).
 */
function settleOnce(game: ConnectGame, winner: ConnectWinner): void {
  if (game.eloSettled) return
  game.eloSettled = true
  const result = winner === 'draw' ? 'draw' : winner === 1 ? 'a' : 'b'
  void settle1v1('connect', game.p1.wallet, game.p2.wallet, result)
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
  settleOnce(game, winner)
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
// registerConnect — wires all events + this module's OWN disconnect
// ---------------------------------------------------------------------------

export function registerConnect(io: Server, socket: Socket): void {
  // ----------------------------------------------------- neonconnect_join
  socket.on('neonconnect_join', (payload: unknown) => {
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

    // Already bound to a game? Active → ignore the join (guards against the
    // client's known effect-loop re-join bug). Ended → the player abandoned
    // the rematch screen; release the old game, then queue them normally.
    const bound = gameOf(socket.id)
    if (bound) {
      if (bound.status === 'active') return
      abandonEndedGame(io, bound, socket.id)
    }

    // One queue slot per wallet: re-emitting join REPLACES the old entry.
    removeFromQueue((e) => e.wallet === wallet)

    // FIFO: take the OLDEST waiting player whose socket is still connected.
    let opponent: ConnectPlayer | undefined
    while (queue.length > 0) {
      const candidate = queue.shift() as ConnectPlayer
      if (io.sockets.sockets.get(candidate.socketId)) {
        opponent = candidate
        break
      }
      // Stale entry — drop it and keep scanning.
    }

    if (!opponent) {
      // No waiting event in the neonconnect protocol — the client renders
      // its own "searching" state until neonconnect_match arrives.
      queue.push({ socketId: socket.id, wallet, name: username })
      return
    }

    const opponentSocket = io.sockets.sockets.get(opponent.socketId) as Socket

    // First-queued = playerId 1 and moves first (client contract).
    const gameId = randomUUID()
    const game: ConnectGame = {
      gameId,
      room: `connect-${gameId}`,
      p1: opponent,
      p2: { socketId: socket.id, wallet, name: username },
      board: new Array<number>(CELLS).fill(0),
      turn: 1,
      status: 'active',
      winner: null,
      resetRequested: { 1: false, 2: false },
      eloSettled: false,
    }
    games.set(gameId, game)
    gameBySocket.set(game.p1.socketId, gameId)
    gameBySocket.set(game.p2.socketId, gameId)
    opponentSocket.join(game.room)
    socket.join(game.room)

    // Per-player payloads: each side learns its seat and whether it opens.
    // Names only — never wallets.
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
  })

  // ----------------------------------------------------- leaveConnectQueue
  socket.on('leaveConnectQueue', () => {
    // No payload by contract — nothing to validate.
    removeFromQueue((e) => e.socketId === socket.id)
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
    game.eloSettled = false // the rematch settles its own result

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
      settleOnce(game, game.winner)
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
    // finished — nothing more to pay out here.
    if (game.status === 'active' && playerId) {
      game.status = 'ended'
      game.winner = playerId === 1 ? 2 : 1
      settleOnce(game, game.winner)
    }

    destroyGame(io, game)
  })
}
