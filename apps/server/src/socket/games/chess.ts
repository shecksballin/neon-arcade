/**
 * CHESS — 1v1 matchmaking, turn-tracked move relay, trust-but-verify endings
 * ==========================================================================
 * Client contract (Chess/ChessGame.tsx + OnlineGame.tsx):
 *
 *   C→S  findGame { name?, avatarUrl? }   — enter the skill-based queue
 *   C→S  leaveQueue                       — leave the queue (no payload)
 *   C→S  makeMove { gameId, move, fen }   — UCI move + post-move FEN
 *   C→S  resign <gameId>                  — bare string payload
 *   C→S  offerDraw <gameId> / acceptDraw <gameId>
 *   C→S  reportGameEnd { gameId, winner, reason }
 *   S→C  waiting <string>                 — legacy queued acknowledgment
 *   S→C  queue:status { game:'chess', mode:'1v1', inQueue, current, needed }
 *          — emitted on EVERY findGame/leaveQueue, duplicates included. This
 *            is the never-silent ack; `waiting` is kept only for old clients.
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

import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { SEASON_START_RP } from '@neon/types'
import { db } from '../../db'
import { users } from '../../db/schema'
// RANKED 2.0: TrueSkill + RP live in rankService; eloService is now only the
// wire projection that strips wallet/mu/sigma out of a settlement result.
import { settleRanked1v1 } from '../../services/rankService'
import { publicRating, type PublicRating } from '../../services/eloService'
// Stats live next to the rating settle: the same exactly-once guard covers
// both, so a rating change and a match_results row can never disagree.
import { recordAndEmitProgression } from './progression'
// Shared matchmaking queue — idempotent and NEVER silent (socket/queue.ts).
// Chess used to run its own array-based queue whose "one slot per wallet,
// replace" path returned without emitting anything, so a second `findGame`
// from the same wallet produced total silence and froze the client's lobby.
import {
  joinQueue,
  leaveQueue as leaveSharedQueue,
  attachQueueCleanup,
  QUEUE_STATUS_EVENT,
  type QueueMatch,
} from '../queue'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// Queue coordinates. Chess has exactly one queue; the mode label only has to
// be stable so the client can filter `queue:status` by { game, mode }.
const CHESS_GAME = 'chess'
const CHESS_MODE = '1v1'
const CHESS_PLAYERS_NEEDED = 2

// How long a solo reportGameEnd stays "pending" waiting for the opponent to
// confirm or contradict it before the server settles it (design contract).
const RESULT_CONFLICT_WINDOW_MS = 10_000

// ---------------------------------------------------------------------------
// Types + module-level registries (one per process — in-memory by design)
// ---------------------------------------------------------------------------

type Color = 'white' | 'black'
type ChessWinner = Color | 'draw'

interface ChessPlayer {
  socketId: string
  wallet: string // NEVER emitted — used only for pairing rules + rating
  name: string // canonical: socket.data.username (never the payload's name)
  avatarUrl: string | null // cosmetic, client-supplied
  rating: number // users.rp1v1 snapshot taken when the player entered the queue
}

/**
 * Per-player extras carried through the shared queue. The rating is snapshotted
 * at JOIN time (not at pairing time) on purpose: it keeps the match handoff
 * fully synchronous, so no `await` window can open between "queue picked these
 * two sockets" and "the game exists" — a window in which a disconnect would
 * have stranded the survivor with no game to clean up.
 */
interface ChessMeta {
  avatarUrl: string | null
  rating: number
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
  /** Exactly-once guard around rankService.settleRanked1v1 (and the stats
   *  write that rides with it). Name kept for continuity with the client
   *  contract docs; it now guards an RP + TrueSkill settlement. */
  eloSettled: boolean
  /** Wall-clock start, for match_results.durationMs (stats only). */
  startedAt: number
  pendingResult: PendingResult | null // trust-but-verify reportGameEnd state
}

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

/**
 * Best-effort VISIBLE RP snapshot for the gameStart payload (the number under
 * each player's name). Reads `users.rp1v1` — the Ranked 2.0 source of truth
 * for this ladder — not the legacy `users.elo` mirror.
 *
 * Falls back to the season-start RP rather than 0 when there is no database,
 * so a DB-less server shows "Copper V", not a rank that does not exist.
 */
async function fetchRating(wallet: string): Promise<number> {
  if (!db) return SEASON_START_RP
  try {
    const [row] = await db
      .select({ rp: users.rp1v1 })
      .from(users)
      .where(eq(users.wallet, wallet))
      .limit(1)
    return row?.rp ?? SEASON_START_RP
  } catch (err) {
    console.error('[chess] rating lookup failed:', err)
    return SEASON_START_RP
  }
}

/** The ACTIVE game this socket is playing, if any (ended bindings ignored). */
function activeGameOf(socketId: string): ChessGame | undefined {
  const gameId = gameBySocket.get(socketId)
  if (!gameId) return undefined
  const game = games.get(gameId)
  return game && game.status === 'active' ? game : undefined
}

/** "You are not in the chess queue." Used wherever we decline to queue —
 *  answering is mandatory so an optimistic client can drop its spinner. */
function emitNotQueued(socket: Socket): void {
  socket.emit(QUEUE_STATUS_EVENT, {
    game: CHESS_GAME,
    mode: CHESS_MODE,
    inQueue: false,
    current: 0,
    needed: CHESS_PLAYERS_NEEDED,
  })
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
 * End a game exactly once: settle RANK (unless voided), emit gameEnded with
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

  let newRatings: { white: PublicRating; black: PublicRating } | null = null
  if (settle && !game.eloSettled) {
    // Flag BEFORE the await so a racing end path can never settle twice.
    game.eloSettled = true
    // Chess is on the '1v1' ladder. A DRAW is a real drawn TrueSkill outcome
    // (never skipped): the hidden skill barely moves and RP only converges
    // toward it, so a draw between equals is worth ~0 RP to both.
    const result = winner === 'white' ? 'a' : winner === 'black' ? 'b' : 'draw'
    const settled = await settleRanked1v1(
      'chess',
      game.white.wallet,
      game.black.wallet,
      result,
      // SAME match id the stats row below uses, so elo_history and
      // match_results can be joined (the history API needs that to show an
      // RP delta next to a match). rankService drops anything non-uuid.
      game.gameId
    )
    // publicRating strips `wallet`, `mu` and `sigma` — the hidden skill layer
    // must never reach a client, and wallets are never leaked to opponents.
    if (settled) {
      newRatings = {
        white: publicRating(settled.a),
        black: publicRating(settled.b),
      }
    }

    // STATS + PROGRESSION — one row per player, written under the SAME
    // eloSettled guard so a game can never be double-recorded (and the void
    // path below, which deliberately skips settlement, records nothing
    // either: a conflicted result is not a result).
    //
    // Chess has no kills/deaths and no score; opponentUsername is the
    // registered handshake username, which is the only public identifier
    // (never a wallet). Fire-and-forget: the same stats write recordResults
    // performed, except each player's XP award is kept and delivered to
    // their own socket as `match:progression` (see games/progression.ts).
    const durationMs = Date.now() - game.startedAt
    void recordAndEmitProgression(io, 'chess', [
      {
        socketId: game.white.socketId,
        ranked: settled?.a ?? null,
        input: {
          matchId: game.gameId, // queue matchId is a uuid; non-uuids are dropped
          wallet: game.white.wallet,
          gameKey: 'chess',
          mode: '1v1',
          result: winner === 'white' ? 'win' : winner === 'black' ? 'loss' : 'draw',
          opponentUsername: game.black.name,
          durationMs,
        },
      },
      {
        socketId: game.black.socketId,
        ranked: settled?.b ?? null,
        input: {
          matchId: game.gameId,
          wallet: game.black.wallet,
          gameKey: 'chess',
          mode: '1v1',
          result: winner === 'black' ? 'win' : winner === 'white' ? 'loss' : 'draw',
          opponentUsername: game.white.name,
          durationMs,
        },
      },
    ])
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
// Match handoff — called by the shared queue with exactly two connected
// players, already joined to `match.room` (`chess-${matchId}`).
//
// SYNCHRONOUS by design: everything it needs (ratings) was snapshotted at join
// time, so there is no await between "these two are paired" and "the game is
// registered + gameStart is out". Throwing here makes the queue put both
// players back at the FRONT of the line and re-emit their status, so a failure
// leaves them searching rather than hanging.
// ---------------------------------------------------------------------------
function startChessMatch(match: QueueMatch<ChessMeta>): void {
  const { io, room, matchId, players } = match
  const [first, second] = players

  const toPlayer = (p: (typeof players)[number]): ChessPlayer => ({
    socketId: p.socketId,
    wallet: p.wallet,
    name: p.username, // canonical handshake username — payloads never trusted
    avatarUrl: p.meta?.avatarUrl ?? null,
    rating: p.meta?.rating ?? 0,
  })

  // Coin-flip colors. whitePlayer.socketId must be the REAL white client's
  // socket.id — the client derives its own color by comparing it to its own.
  const firstIsWhite = Math.random() < 0.5
  const white = toPlayer(firstIsWhite ? first : second)
  const black = toPlayer(firstIsWhite ? second : first)

  const game: ChessGame = {
    gameId: matchId, // the queue's matchId IS the gameId (room stays chess-…)
    room,
    white,
    black,
    fen: START_FEN,
    moves: [],
    turn: 'white',
    status: 'active',
    eloSettled: false,
    startedAt: Date.now(),
    pendingResult: null,
  }
  games.set(game.gameId, game)
  gameBySocket.set(white.socketId, game.gameId)
  gameBySocket.set(black.socketId, game.gameId)

  io.to(room).emit('gameStart', {
    mode: 'multiplayer', // literal string is load-bearing client-side
    gameId: game.gameId,
    whitePlayer: publicPlayer(white),
    blackPlayer: publicPlayer(black),
  })
}

// ---------------------------------------------------------------------------
// registerChess — wires all chess events + this module's OWN disconnect
// ---------------------------------------------------------------------------

export function registerChess(io: Server, socket: Socket): void {
  // Queue cleanup on disconnect is owned by the shared queue module and is
  // idempotent — attaching it here means a socket that never queued still gets
  // swept if it somehow ends up holding a slot.
  attachQueueCleanup(socket, io)

  // ------------------------------------------------------------- findGame
  //
  // ALWAYS answers. joinQueue emits `queue:status` (and the legacy `waiting`
  // ack) on EVERY call — first join, duplicate click, reconnect — which is the
  // fix for "the 2nd search attempt is met with silence".
  socket.on('findGame', async (payload: unknown) => {
    const parsed = findGameSchema.safeParse(payload ?? {})
    if (!parsed.success) return

    // Already in an active chess game on THIS socket → don't queue it twice.
    // Still answer (never silent) so an optimistic client that is showing the
    // searching screen can drop it instead of spinning forever.
    if (activeGameOf(socket.id)) {
      emitNotQueued(socket)
      return
    }

    // Snapshot the VISIBLE RP before queueing so the handoff below stays
    // synchronous (see startChessMatch). This is display only — matchmaking
    // pairs on HIDDEN skill, which socket/queue.ts snapshots itself from the
    // '1v1' ladder. Best-effort: play is never gated on the database.
    const wallet = socket.data.wallet as string | undefined
    const rating = wallet ? await fetchRating(wallet) : SEASON_START_RP

    // The lookup above is async: re-check that a CONCURRENT findGame (double
    // click / reconnect replay) didn't pair this socket while we waited on the
    // DB. Without this the socket could sit in the queue *and* in a live game.
    if (activeGameOf(socket.id)) {
      emitNotQueued(socket)
      return
    }

    await joinQueue<ChessMeta>({
      socket,
      io,
      game: CHESS_GAME,
      mode: CHESS_MODE,
      needed: CHESS_PLAYERS_NEEDED,
      // §5.3: pair on hidden skill from the '1v1' pool, not on arrival order.
      ladder: '1v1',
      meta: { avatarUrl: parsed.data.avatarUrl ?? null, rating },
      // Pre-existing clients still listen for `waiting`; both events go out.
      legacyAck: { event: 'waiting', payload: 'Waiting for opponent...' },
      onMatch: startChessMatch,
    })
  })

  // ------------------------------------------------------------ leaveQueue
  // Cancel / unmount / view change. Idempotent and never silent: even a socket
  // that held no slot gets `queue:status { inQueue: false }` back.
  socket.on('leaveQueue', () => {
    // No payload by contract — nothing to validate.
    leaveSharedQueue({ socket, io, game: CHESS_GAME })
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
    // Queue slots are swept by the shared queue's own disconnect listener
    // (attachQueueCleanup above) — this handler only owns live games.
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
