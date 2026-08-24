/**
 * NEON KICKOFF (penalty shootout) — registerKickoff(io, socket)
 * =============================================================
 * Server-authoritative 1v1 penalty shootout, replacing Neon Quiz in the
 * arcade's online line-up. The client renders the 3D theatre; every OUTCOME
 * is decided here from three inputs, using the exact rule the practice game
 * plays by (apps/web/src/components/neonKickoff/game/store.ts):
 *
 *     outcome = zone === 'red'   ? 'off'    (mistimed — skied it)
 *             : guess === dir    ? 'saved'  (keeper read it)
 *             :                    'goal'
 *
 * `zone` is the striker's ring timing and `dir` their corner — gameplay
 * INPUTS, exactly like a volley paddle position: the server never trusts a
 * client's *result*, but inputs are the player's own to make. The keeper's
 * `guess` is whatever their latest kickoff_guess said when the strike lands
 * (default 'middle', matching practice's "touch nothing to hold the middle").
 *
 * Flow:
 *   kickoff_find {}                    → shared SKILL queue ('1v1' ladder)
 *     → on pair: room `kickoff-${gameId}`, per-player
 *       kickoff_match { gameId, youAre: 1|2, opponent, round: 1 }
 *       (p1 = FIFO-longest waiter, kicks first — practice's "player leads")
 *   kickoff_strike { gameId, dir, zone }   — current KICKER only
 *   kickoff_guess  { gameId, dir }         — current KEEPER only, last wins
 *     → on strike: room kickoff_kick { kicker, dir, zone, guess, outcome,
 *       kicks: {p1, p2}, next: {kicker, round, suddenDeath} | null }
 *     → when decided: room kickoff_ended { winner: 1|2, reason, newRatings }
 *       plus per-player `match:progression` (games/progression.ts)
 *   kickoff_leave                      — voluntary forfeit, same as connect
 *
 * STALL CLOCK: the kicker gets KICK_TIMEOUT_MS per attempt; silence is an
 * automatic red-zone kick (skied). Nobody can hold a shootout hostage by
 * never striking. The keeper needs no clock — their default already stands.
 *
 * Shootout bookkeeping is a 1:1 port of the client's pure shootout.ts
 * (best of 5, early decision, sudden death), so both ends always agree on
 * when it is over.
 *
 * RANK/STATS: settleRanked1v1('kickoff', …) on the '1v1' ladder exactly once
 * per finished match (eloSettled guard), stats + XP via
 * recordAndEmitProgression — identical funnels to chess/volley/connect.
 */

import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import { settleRanked1v1 } from '../../services/rankService'
import { publicRating, type PublicRating } from '../../services/eloService'
import { recordAndEmitProgression } from './progression'
import {
  joinQueue,
  leaveQueue as leaveSharedQueue,
  attachQueueCleanup,
  QUEUE_STATUS_EVENT,
  type QueueMatch,
} from '../queue'

const KICKOFF_GAME = 'kickoff'
const PLAYERS_NEEDED = 2
/** Regulation kicks per side before sudden death. */
const REGULATION = 5
/** The kicker's shot clock — silence skies the ball automatically. */
const KICK_TIMEOUT_MS = 30_000
/**
 * The kicker's EARLIEST accepted strike, from the moment the attempt arms.
 * An honest client physically cannot strike before ~3.2s (1.9s intro + the
 * ring's first green ≥1.3s), but a modified one that fires the instant the
 * previous kick broadcasts would catch every keeper on the default 'middle'
 * guess — a deterministic ranked win. Early strikes are ignored outright;
 * the 30s stall clock above still bounds the other direction.
 */
const MIN_STRIKE_MS = 2_500
/** Attempts per side before the shootout is CALLED as a draw — two idle
 *  clients auto-skying forever must not hold a game object immortal. */
const MAX_ATTEMPTS_EACH = 20

type Dir = 'left' | 'middle' | 'right'
type Zone = 'green' | 'orange' | 'red'
type Outcome = 'goal' | 'saved' | 'off'
type PlayerId = 1 | 2

interface KickoffPlayer {
  socketId: string
  wallet: string
  name: string
}

interface KickoffGame {
  gameId: string
  room: string
  status: 'active' | 'ended'
  p1: KickoffPlayer // kicks first (FIFO-longest waiter)
  p2: KickoffPlayer
  /** per-side attempt results, true = scored — mirrors client shootout.ts */
  kicks: { p1: boolean[]; p2: boolean[] }
  /** whose kick is live right now */
  kicker: PlayerId
  /** the keeper's latest committed dive for the live kick */
  guess: Dir
  kickTimer: ReturnType<typeof setTimeout> | null
  /** When the live attempt armed — the floor for MIN_STRIKE_MS. */
  attemptArmedAt: number
  eloSettled: boolean
  startedAt: number
}

const games = new Map<string, KickoffGame>()
const gameBySocket = new Map<string, string>()

// ─────────────────────────────────────────────────
// Shootout bookkeeping — 1:1 port of the client's pure shootout.ts
// ─────────────────────────────────────────────────

function goals(k: boolean[]): number {
  return k.filter(Boolean).length
}

function nextKicker(g: KickoffGame): PlayerId {
  return g.kicks.p1.length <= g.kicks.p2.length ? 1 : 2
}

function roundNumber(g: KickoffGame): number {
  return Math.min(g.kicks.p1.length, g.kicks.p2.length) + 1
}

function inSuddenDeath(g: KickoffGame): boolean {
  return g.kicks.p1.length >= REGULATION && g.kicks.p2.length >= REGULATION
}

/** The decision rule, verbatim from the client (early decision + sudden death). */
function decideWinner(g: KickoffGame): PlayerId | null {
  const g1 = goals(g.kicks.p1)
  const g2 = goals(g.kicks.p2)
  const t1 = g.kicks.p1.length
  const t2 = g.kicks.p2.length

  if (t1 <= REGULATION && t2 <= REGULATION) {
    const left1 = REGULATION - t1
    const left2 = REGULATION - t2
    if (g1 > g2 + left2) return 1
    if (g2 > g1 + left1) return 2
    return null
  }
  if (t1 === t2 && t1 > REGULATION) {
    if (g1 !== g2) return g1 > g2 ? 1 : 2
  }
  return null
}

// ─────────────────────────────────────────────────
// Payload schemas
// ─────────────────────────────────────────────────

const DirSchema = z.enum(['left', 'middle', 'right'])

const strikeSchema = z.object({
  gameId: z.string().min(1).max(64),
  dir: DirSchema,
  zone: z.enum(['green', 'orange', 'red']),
})

const guessSchema = z.object({
  gameId: z.string().min(1).max(64),
  dir: DirSchema,
})

// ─────────────────────────────────────────────────
// Game lifecycle
// ─────────────────────────────────────────────────

function playerOf(g: KickoffGame, id: PlayerId): KickoffPlayer {
  return id === 1 ? g.p1 : g.p2
}

function idOf(g: KickoffGame, socketId: string): PlayerId | null {
  if (g.p1.socketId === socketId) return 1
  if (g.p2.socketId === socketId) return 2
  return null
}

function destroyGame(io: Server, g: KickoffGame): void {
  if (g.kickTimer) {
    clearTimeout(g.kickTimer)
    g.kickTimer = null
  }
  for (const sid of [g.p1.socketId, g.p2.socketId]) {
    if (gameBySocket.get(sid) === g.gameId) gameBySocket.delete(sid)
    io.sockets.sockets.get(sid)?.leave(g.room)
  }
  games.delete(g.gameId)
}

/** Arm the kicker's shot clock; firing skies the ball (red-zone kick). */
function armKickTimer(io: Server, g: KickoffGame): void {
  if (g.kickTimer) clearTimeout(g.kickTimer)
  g.attemptArmedAt = Date.now()
  g.kickTimer = setTimeout(() => {
    if (g.status !== 'active') return
    resolveStrike(io, g, 'middle', 'red')
  }, KICK_TIMEOUT_MS)
}

/**
 * A strike landed (from the kicker, or the stall clock). Decide the outcome,
 * record it, broadcast the kick, and either advance the round or finish.
 */
function resolveStrike(io: Server, g: KickoffGame, dir: Dir, zone: Zone): void {
  if (g.status !== 'active') return
  if (g.kickTimer) {
    clearTimeout(g.kickTimer)
    g.kickTimer = null
  }

  const guess = g.guess
  const outcome: Outcome = zone === 'red' ? 'off' : guess === dir ? 'saved' : 'goal'

  const side = g.kicker === 1 ? 'p1' : 'p2'
  g.kicks[side] = [...g.kicks[side], outcome === 'goal']

  let winner: PlayerId | 0 | null = decideWinner(g)
  // Immortality cap: two connected-but-idle clients auto-sky forever (every
  // sudden-death pair ties 0-0). Past the cap the match is CALLED as a draw
  // — a real drawn TrueSkill outcome, not a coin-flip winner.
  if (
    winner === null &&
    g.kicks.p1.length >= MAX_ATTEMPTS_EACH &&
    g.kicks.p2.length >= MAX_ATTEMPTS_EACH
  ) {
    winner = 0
  }

  // Reset the live-kick state for the next attempt before broadcasting, so
  // the payload's `next` block reflects the true upcoming state.
  const kicker = g.kicker
  if (!winner) {
    g.kicker = nextKicker(g)
    g.guess = 'middle'
  }

  io.to(g.room).emit('kickoff_kick', {
    kicker,
    dir,
    zone,
    guess,
    outcome,
    kicks: { p1: g.kicks.p1, p2: g.kicks.p2 },
    next:
      winner !== null
        ? null
        : {
            kicker: g.kicker,
            round: roundNumber(g),
            suddenDeath: inSuddenDeath(g),
          },
  })

  if (winner !== null) {
    void endGame(io, g, winner, winner === 0 ? 'exhausted' : 'decided')
  } else {
    armKickTimer(io, g)
  }
}

/** The ONE end funnel — natural decisions and forfeits both land here. */
async function endGame(
  io: Server,
  g: KickoffGame,
  /** 0 = called as a draw (round cap) — both sides settle a drawn outcome. */
  winner: PlayerId | 0,
  reason: 'decided' | 'forfeit' | 'exhausted'
): Promise<void> {
  if (g.status === 'ended') return
  g.status = 'ended'
  if (g.kickTimer) {
    clearTimeout(g.kickTimer)
    g.kickTimer = null
  }

  let newRatings: { p1: PublicRating; p2: PublicRating } | null = null
  let settled: Awaited<ReturnType<typeof settleRanked1v1>> = null
  if (!g.eloSettled) {
    g.eloSettled = true
    settled = await settleRanked1v1(
      KICKOFF_GAME,
      g.p1.wallet,
      g.p2.wallet,
      winner === 0 ? 'draw' : winner === 1 ? 'a' : 'b',
      g.gameId // same uuid as the stats rows → elo_history joins match_results
    )
    if (settled) {
      newRatings = { p1: publicRating(settled.a), p2: publicRating(settled.b) }
    }

    // STATS + PROGRESSION — score = goals scored from the spot.
    const durationMs = Date.now() - g.startedAt
    void recordAndEmitProgression(io, KICKOFF_GAME, [
      {
        socketId: g.p1.socketId,
        ranked: settled?.a ?? null,
        input: {
          matchId: g.gameId,
          wallet: g.p1.wallet,
          gameKey: KICKOFF_GAME,
          mode: '1v1',
          result: winner === 0 ? 'draw' : winner === 1 ? 'win' : 'loss',
          score: goals(g.kicks.p1),
          opponentUsername: g.p2.name,
          durationMs,
        },
      },
      {
        socketId: g.p2.socketId,
        ranked: settled?.b ?? null,
        input: {
          matchId: g.gameId,
          wallet: g.p2.wallet,
          gameKey: KICKOFF_GAME,
          mode: '1v1',
          result: winner === 0 ? 'draw' : winner === 2 ? 'win' : 'loss',
          score: goals(g.kicks.p2),
          opponentUsername: g.p1.name,
          durationMs,
        },
      },
    ])
  }

  // Socket ids, not the room — a disconnect mid-settle pulls the survivor
  // out of the room too (destroyGame), and they must still hear the end.
  io.to([g.p1.socketId, g.p2.socketId]).emit('kickoff_ended', {
    winner,
    reason,
    newRatings,
  })
  destroyGame(io, g)
}

// ─────────────────────────────────────────────────
// Match handoff — the shared queue hands us two connected players
// ─────────────────────────────────────────────────

function startKickoffMatch(match: QueueMatch): void {
  const { io, room, matchId, players } = match

  const toPlayer = (p: (typeof players)[number]): KickoffPlayer => ({
    socketId: p.socketId,
    wallet: p.wallet,
    name: p.username, // canonical handshake username — payloads never trusted
  })

  const game: KickoffGame = {
    gameId: matchId,
    room,
    status: 'active',
    p1: toPlayer(players[0]), // FIFO: longest waiter kicks first
    p2: toPlayer(players[1]),
    kicks: { p1: [], p2: [] },
    kicker: 1,
    guess: 'middle',
    kickTimer: null,
    attemptArmedAt: Date.now(),
    eloSettled: false,
    startedAt: Date.now(),
  }
  games.set(game.gameId, game)
  gameBySocket.set(game.p1.socketId, game.gameId)
  gameBySocket.set(game.p2.socketId, game.gameId)

  // Per-player: each side learns which seat is theirs. Wallets never leave
  // the server; the opponent is a username only.
  io.to(game.p1.socketId).emit('kickoff_match', {
    gameId: game.gameId,
    youAre: 1,
    opponent: game.p2.name,
    round: 1,
  })
  io.to(game.p2.socketId).emit('kickoff_match', {
    gameId: game.gameId,
    youAre: 2,
    opponent: game.p1.name,
    round: 1,
  })

  armKickTimer(io, game)
}

// ─────────────────────────────────────────────────
// registerKickoff — wires all events + this module's OWN disconnect
// ─────────────────────────────────────────────────

export function registerKickoff(io: Server, socket: Socket): void {
  attachQueueCleanup(socket, io)

  socket.on('kickoff_find', async () => {
    // Already in a shootout → answer (never silent) without double-queueing.
    const existing = gameBySocket.get(socket.id)
    if (existing && games.get(existing)?.status === 'active') {
      socket.emit(QUEUE_STATUS_EVENT, {
        game: KICKOFF_GAME,
        mode: '1v1',
        inQueue: false,
        current: 0,
        needed: PLAYERS_NEEDED,
      })
      return
    }

    await joinQueue({
      socket,
      io,
      game: KICKOFF_GAME,
      mode: '1v1',
      needed: PLAYERS_NEEDED,
      // Skill-paired from the shared 1v1 pool, like every other duel.
      ladder: '1v1',
      onMatch: startKickoffMatch,
    })
  })

  socket.on('kickoff_leaveQueue', () => {
    leaveSharedQueue({ socket, io, game: KICKOFF_GAME })
  })

  socket.on('kickoff_strike', (payload) => {
    const parsed = strikeSchema.safeParse(payload)
    if (!parsed.success) return
    const g = games.get(parsed.data.gameId)
    if (!g || g.status !== 'active') return
    // Only the CURRENT kicker may strike — a keeper spamming strike events
    // must never resolve their opponent's attempt.
    if (idOf(g, socket.id) !== g.kicker) return
    // Blitz guard: see MIN_STRIKE_MS. The stall clock still runs, so an
    // ignored early strike costs the cheater their window, not ours.
    if (Date.now() - g.attemptArmedAt < MIN_STRIKE_MS) return
    resolveStrike(io, g, parsed.data.dir, parsed.data.zone)
  })

  socket.on('kickoff_guess', (payload) => {
    const parsed = guessSchema.safeParse(payload)
    if (!parsed.success) return
    const g = games.get(parsed.data.gameId)
    if (!g || g.status !== 'active') return
    const id = idOf(g, socket.id)
    // Only the current KEEPER commits a dive; last one before the strike wins.
    if (id === null || id === g.kicker) return
    g.guess = parsed.data.dir
  })

  // Voluntary mid-match exit — the survivor takes the forfeit win, exactly
  // like connect's leave path (the exit guard on the client emits this).
  socket.on('kickoff_leave', () => {
    leaveSharedQueue({ socket, io, game: KICKOFF_GAME })
    const gameId = gameBySocket.get(socket.id)
    const g = gameId ? games.get(gameId) : undefined
    if (!g) return
    const id = idOf(g, socket.id)
    if (g.status === 'active' && id) {
      void endGame(io, g, id === 1 ? 2 : 1, 'forfeit')
    } else {
      destroyGame(io, g)
    }
  })

  // Per-module disconnect cleanup (design contract: no central loop).
  socket.on('disconnect', () => {
    const gameId = gameBySocket.get(socket.id)
    gameBySocket.delete(socket.id)
    const g = gameId ? games.get(gameId) : undefined
    if (!g) return
    const id = idOf(g, socket.id)
    if (g.status === 'active' && id) {
      void endGame(io, g, id === 1 ? 2 : 1, 'forfeit')
    } else {
      destroyGame(io, g)
    }
  })
}
