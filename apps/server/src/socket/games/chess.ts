/**
 * CHESS — 1v1 matchmaking, turn-tracked move relay, trust-but-verify endings
 * ==========================================================================
 * Client contract (Chess/ChessGame.tsx + OnlineGame.tsx):
 *
 *   C→S  findGame { name?, avatarUrl? }   — enter the FIFO queue
 *   C→S  leaveQueue                       — leave the queue (no payload)
 *   C→S  makeMove { gameId, move, fen }   — UCI move + post-move FEN
 *   C→S  resign <gameId>                  — bare string payload
 *   C→S  offerDraw <gameId> / acceptDraw <gameId>
 *   C→S  reportGameEnd { gameId, winner, reason }
 *   S→C  waiting <string>                 — queued acknowledgment
 *   S→C  gameStart { mode:'multiplayer', gameId, whitePlayer, blackPlayer }
 *   S→C  moveMade { move, fen, moveNumber } — OPPONENT ONLY (see below)
 *   S→C  drawOffered                      — opponent socket only
 *   S→C  gameEnded { reason, winner, newRatings }  — newRatings ALWAYS present (may be null)
 *   S→C  opponentDisconnected             — before gameEnded on a disconnect
 *   S→C  gameAuthError { code, message }  — matchmaking refused (no account)
 *
 * Load-bearing client details (from the contract audit):
 * - gameStart.mode MUST be the literal 'multiplayer' — the client's
 *   resign-on-exit guards test that exact string.
 * - whitePlayer.socketId MUST be the actual white client's socket.id — the
 *   client derives its color by comparing it against its own id.
 * - moveMade is relayed to the OPPONENT ONLY (socket.to(room)). An echo to
 *   the mover passes the client's turn guard and relies on chess.js
 *   rejecting the replay — fragile, so we never echo.
 *
 * Identity: socket.data.wallet / socket.data.username (handshake auth).
 * Wallets are server-side bookkeeping ONLY and are never emitted.
 */

import { randomUUID } from 'node:crypto'
import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { users } from '../../db/schema'
import { settle1v1, type RatingAfter } from '../../services/eloService'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// How long a solo reportGameEnd stays "pending" waiting for the opponent to
// confirm or contradict it before the server settles it (design contract).
const RESULT_CONFLICT_WINDOW_MS = 10_000

// ---------------------------------------------------------------------------
// Types + module-level registries (one per process — in-memory by design)
// ---------------------------------------------------------------------------

type Color = 'white' | 'black'
type ChessWinner = Color | 'draw'

interface QueueEntry {
  socketId: string
  wallet: string // NEVER emitted — used only for pairing rules + ELO
  name: string // canonical: socket.data.username (never the payload's name)
  avatarUrl: string | null // cosmetic, client-supplied
}

interface ChessPlayer extends QueueEntry {
  rating: number // users.elo snapshot at match time (0 when no DB)
}

interface PendingResult {
  winner: ChessWinner
  reason: string
  reporterSocketId: string
  timer: ReturnType<typeof setTimeout>
}

interface ChessGame {
  gameId: string
  room: string // `chess-${gameId}`
  white: ChessPlayer
  black: ChessPlayer
  fen: string
  moves: string[]
  turn: Color // server-tracked; alternates on each ACCEPTED move
  status: 'active' | 'ended'
  eloSettled: boolean // exactly-once guard around eloService.settle1v1
  pendingResult: PendingResult | null // trust-but-verify reportGameEnd state
}

// FIFO queue (shift(), not the reference server's LIFO pop()).
const queue: QueueEntry[] = []
// gameId → game, plus a socket.id → gameId index for O(1) lookups.
const games = new Map<string, ChessGame>()
const gameBySocket = new Map<string, string>()

// ---------------------------------------------------------------------------
// Zod schemas — every inbound payload is safeParse'd; bad shapes are ignored
// ---------------------------------------------------------------------------

const findGameSchema = z.object({
  // name is accepted but IGNORED — the canonical display name is the
  // registered username from the handshake (never trust payload identity).
  name: z.string().max(64).optional(),
  avatarUrl: z.string().max(512).optional(), // cosmetic only
})

const makeMoveSchema = z.object({
  gameId: z.string().min(1).max(64),
  move: z.string().min(1).max(10), // UCI, e.g. 'e2e4' / 'e7e8q'
  fen: z.string().min(1).max(120),
})

// resign / offerDraw / acceptDraw send a BARE gameId string (client contract).
const gameIdSchema = z.string().min(1).max(64)

const reportGameEndSchema = z.object({
  gameId: z.string().min(1).max(64),
  // ONLY these three values are ever accepted (design contract) — the
  // reference server's "any winner string" hole is closed here.
  winner: z.enum(['white', 'black', 'draw']),
  reason: z.string().max(64).optional(),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove every queue entry matching the predicate (splice in place). */
function removeFromQueue(match: (entry: QueueEntry) => boolean): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (match(queue[i])) queue.splice(i, 1)
  }
}

/** Best-effort users.elo snapshot for the gameStart payload. 0 on no DB. */
async function fetchRating(wallet: string): Promise<number> {
  if (!db) return 0
  try {
    const [row] = await db
      .select({ elo: users.elo })
      .from(users)
      .where(eq(users.wallet, wallet))
      .limit(1)
    return row?.elo ?? 0
  } catch (err) {
    console.error('[chess] rating lookup failed:', err)
    return 0
  }
}

/** Which color a socket plays in a game, or null if not a participant. */
function colorOf(game: ChessGame, socketId: string): Color | null {
  if (game.white.socketId === socketId) return 'white'
  if (game.black.socketId === socketId) return 'black'
  return null
}

/** Public projection of a player — strips the wallet (never leak wallets). */
function publicPlayer(p: ChessPlayer) {
  return {
    socketId: p.socketId,
    name: p.name,
    avatarUrl: p.avatarUrl,
    rating: p.rating,
  }
}

/** Drop the game from every registry and pull both sockets out of the room. */
function destroyGame(io: Server, game: ChessGame): void {
  for (const sid of [game.white.socketId, game.black.socketId]) {
    // Only unbind if the index still points at THIS game — a socket may have
    // already been rebound (defensive; normal flow never overlaps).
    if (gameBySocket.get(sid) === game.gameId) gameBySocket.delete(sid)
    io.sockets.sockets.get(sid)?.leave(game.room)
  }
  games.delete(game.gameId)
}

/**
 * End a game exactly once: settle ELO (unless voided), emit gameEnded with
 * newRatings (ALWAYS present — null when unrated/voided/no-DB), clean up.
 *
 * `settle=false` is the conflict path: two contradicting reportGameEnd
 * claims void the game — declared a draw with NO rating change, so a cheater
 * gains nothing by racing a fake result (design contract).
 */
async function endGame(
  io: Server,
  game: ChessGame,
  reason: string,
  winner: ChessWinner,
  settle = true
): Promise<void> {
  if (game.status === 'ended') return // idempotent — first ender wins
  game.status = 'ended'

  // A pending trust-but-verify timer must never fire on a finished game.
  if (game.pendingResult) {
    clearTimeout(game.pendingResult.timer)
    game.pendingResult = null
  }

  let newRatings: { white: RatingAfter; black: RatingAfter } | null = null
  if (settle && !game.eloSettled) {
    // Flag BEFORE the await so a racing end path can never settle twice.
    game.eloSettled = true
    // Draws settle with S=0.5 (contract) — NOT skipped like the ref server.
    const result = winner === 'white' ? 'a' : winner === 'black' ? 'b' : 'draw'
    const settled = await settle1v1(
      'chess',
      game.white.wallet,
      game.black.wallet,
      result
    )
    if (settled) newRatings = { white: settled.a, black: settled.b }
  }

  // Emit to both players' PRIVATE rooms (their socket ids), not the game
  // room: if a socket disconnected during the settle await above, its
  // disconnect cleanup already ran destroyGame — which pulls the SURVIVOR
  // out of the game room too — so a room emit would reach nobody. Targeting
  // socket ids always reaches whoever is still connected; a vanished socket
  // is a harmless no-op.
  io.to([game.white.socketId, game.black.socketId]).emit('gameEnded', {
    reason,
    winner,
    newRatings,
  })
  destroyGame(io, game)
}

// ---------------------------------------------------------------------------
// registerChess — wires all chess events + this module's OWN disconnect
// ---------------------------------------------------------------------------

export function registerChess(io: Server, socket: Socket): void {
  // ------------------------------------------------------------- findGame
  socket.on('findGame', async (payload: unknown) => {
    const parsed = findGameSchema.safeParse(payload ?? {})
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

    // Already in an active chess game → ignore (stale ended bindings are
    // cleared by endGame/disconnect, so this only blocks real double-joins).
    const boundId = gameBySocket.get(socket.id)
    if (boundId && games.get(boundId)?.status === 'active') return

    // One queue slot per wallet: re-emitting findGame REPLACES the old entry
    // (covers reconnects and second tabs — the newest socket wins the slot).
    removeFromQueue((e) => e.wallet === wallet)

    const entry: QueueEntry = {
      socketId: socket.id,
      wallet,
      name: username,
      avatarUrl: parsed.data.avatarUrl ?? null,
    }

    // FIFO: take the OLDEST waiting player whose socket is still connected.
    let opponent: QueueEntry | undefined
    while (queue.length > 0) {
      const candidate = queue.shift() as QueueEntry
      if (io.sockets.sockets.get(candidate.socketId)) {
        opponent = candidate
        break
      }
      // Stale entry (socket vanished without cleanup) — drop and keep going.
    }

    if (!opponent) {
      queue.push(entry)
      socket.emit('waiting', 'Waiting for opponent...') // client ignores text
      return
    }

    // Snapshot ratings for the start payload (best-effort; 0 without a DB).
    const [entryRating, opponentRating] = await Promise.all([
      fetchRating(entry.wallet),
      fetchRating(opponent.wallet),
    ])

    // The awaits above opened a window — re-verify both sockets survived it.
    const opponentSocket = io.sockets.sockets.get(opponent.socketId)
    if (!opponentSocket) {
      // Opponent vanished mid-pairing: we become the waiter instead.
      queue.push(entry)
      socket.emit('waiting', 'Waiting for opponent...')
      return
    }
    if (socket.disconnected) {
      // WE vanished: the patient opponent goes back to the FRONT of the line.
      queue.unshift(opponent)
      return
    }
    if (gameBySocket.has(socket.id)) {
      // A concurrent findGame from this socket already paired it during the
      // awaits — never bind one socket to two games; requeue the opponent.
      queue.unshift(opponent)
      return
    }

    // Coin-flip colors. whitePlayer.socketId must be the real white client's
    // socket.id — the client derives its own color from it.
    const entryIsWhite = Math.random() < 0.5
    const whiteEntry = entryIsWhite ? entry : opponent
    const blackEntry = entryIsWhite ? opponent : entry
    const ratingOf = (e: QueueEntry) =>
      e.wallet === entry.wallet ? entryRating : opponentRating

    const gameId = randomUUID()
    const game: ChessGame = {
      gameId,
      room: `chess-${gameId}`,
      white: { ...whiteEntry, rating: ratingOf(whiteEntry) },
      black: { ...blackEntry, rating: ratingOf(blackEntry) },
      fen: START_FEN,
      moves: [],
      turn: 'white',
      status: 'active',
      eloSettled: false,
      pendingResult: null,
    }
    games.set(gameId, game)
    gameBySocket.set(game.white.socketId, gameId)
    gameBySocket.set(game.black.socketId, gameId)
    // Close the re-entrancy window: a duplicate findGame emitted during the
    // rating awaits could have re-queued either wallet — sweep both out so
    // neither paired player also holds a queue slot.
    removeFromQueue(
      (e) => e.wallet === entry.wallet || e.wallet === opponent.wallet
    )
    socket.join(game.room)
    opponentSocket.join(game.room)

    io.to(game.room).emit('gameStart', {
      mode: 'multiplayer', // literal string is load-bearing client-side
      gameId,
      whitePlayer: publicPlayer(game.white),
      blackPlayer: publicPlayer(game.black),
    })
  })

  // ------------------------------------------------------------ leaveQueue
  socket.on('leaveQueue', () => {
    // No payload by contract — nothing to validate.
    removeFromQueue((e) => e.socketId === socket.id)
  })

  // -------------------------------------------------------------- makeMove
  socket.on('makeMove', (payload: unknown) => {
    const parsed = makeMoveSchema.safeParse(payload)
    if (!parsed.success) return

    const game = games.get(parsed.data.gameId)
    if (!game || game.status !== 'active') return

    const color = colorOf(game, socket.id)
    if (!color) return // sender is not a participant of this game
    if (game.turn !== color) return // out-of-turn move — rejected

    // TODO(chess-validation): full chess.js legality validation server-side
    // is explicitly out of scope this pass — we enforce participants + turn
    // order and store the client-reported FEN/moves for bookkeeping only.
    game.fen = parsed.data.fen
    game.moves.push(parsed.data.move)
    game.turn = game.turn === 'white' ? 'black' : 'white'

    // OPPONENT ONLY — never echo to the mover (see file header).
    socket.to(game.room).emit('moveMade', {
      move: parsed.data.move,
      fen: game.fen,
      moveNumber: game.moves.length,
    })
  })

  // ---------------------------------------------------------------- resign
  socket.on('resign', (payload: unknown) => {
    const parsed = gameIdSchema.safeParse(payload)
    if (!parsed.success) return

    const game = games.get(parsed.data)
    if (!game || game.status !== 'active') return

    const color = colorOf(game, socket.id)
    if (!color) return

    // Winner is the OTHER player; resigner takes the rating loss.
    void endGame(io, game, 'resignation', color === 'white' ? 'black' : 'white')
  })

  // ------------------------------------------------------------- offerDraw
  socket.on('offerDraw', (payload: unknown) => {
    const parsed = gameIdSchema.safeParse(payload)
    if (!parsed.success) return

    const game = games.get(parsed.data)
    if (!game || game.status !== 'active') return

    const color = colorOf(game, socket.id)
    if (!color) return

    // Offer goes to the opponent's socket ONLY (as the reference server did;
    // there is no decline event in the protocol — silence means declined).
    const opponentId =
      color === 'white' ? game.black.socketId : game.white.socketId
    io.to(opponentId).emit('drawOffered')
  })

  // ------------------------------------------------------------ acceptDraw
  socket.on('acceptDraw', (payload: unknown) => {
    const parsed = gameIdSchema.safeParse(payload)
    if (!parsed.success) return

    const game = games.get(parsed.data)
    if (!game || game.status !== 'active') return
    if (!colorOf(game, socket.id)) return

    // Draws ARE rated (S=0.5 both sides) and gameEnded ALWAYS carries
    // newRatings — both deliberate fixes over the reference server.
    void endGame(io, game, 'draw', 'draw')
  })

  // --------------------------------------------------------- reportGameEnd
  socket.on('reportGameEnd', (payload: unknown) => {
    const parsed = reportGameEndSchema.safeParse(payload)
    if (!parsed.success) return // also rejects any non-white/black/draw winner

    const game = games.get(parsed.data.gameId)
    if (!game || game.status !== 'active') return
    if (!colorOf(game, socket.id)) return

    const winner = parsed.data.winner
    const reason = parsed.data.reason ?? 'checkmate'

    // TRUST-BUT-VERIFY (design contract): checkmate/stalemate are detected
    // CLIENT-side by chess.js and the server can't re-verify without a chess
    // engine (see the TODO in makeMove). So results are double-entry:
    //   1. the FIRST report is held as pending for 10 seconds
    //   2. opponent reports the SAME result   → confirmed, settle now
    //   3. opponent reports a DIFFERENT one   → conflict, VOID the game:
    //      declared a draw with NO rating change so a fabricated result can
    //      never earn ELO — worst case a cheater forces a void
    //   4. window expires with no second report → settle the first report
    const pending = game.pendingResult
    if (!pending) {
      game.pendingResult = {
        winner,
        reason,
        reporterSocketId: socket.id,
        timer: setTimeout(() => {
          void endGame(io, game, reason, winner)
        }, RESULT_CONFLICT_WINDOW_MS),
      }
      return
    }

    if (pending.reporterSocketId === socket.id) return // duplicate — ignore

    if (pending.winner === winner) {
      // Both sides agree — settle immediately with the confirmed result.
      void endGame(io, game, pending.reason, pending.winner)
    } else {
      // Contradiction — void: draw, settle=false means NO rating change.
      void endGame(io, game, 'conflict', 'draw', false)
    }
  })

  // ------------------------------------------------------------ disconnect
  // Per-module cleanup (design contract: no central disconnect loop).
  socket.on('disconnect', () => {
    removeFromQueue((e) => e.socketId === socket.id)

    const gameId = gameBySocket.get(socket.id)
    if (!gameId) return
    const game = games.get(gameId)
    gameBySocket.delete(socket.id)
    if (!game) return

    if (game.status !== 'active') {
      // Already ended (settled elsewhere) — just make sure it's cleaned up.
      destroyGame(io, game)
      return
    }

    const color = colorOf(game, socket.id)
    if (!color) return

    // Survivor wins; ELO settles exactly ONCE via endGame's guard. The bare
    // opponentDisconnected precedes gameEnded (client resets to lobby on it).
    io.to(game.room).emit('opponentDisconnected')
    void endGame(io, game, 'disconnect', color === 'white' ? 'black' : 'white')
  })
}
