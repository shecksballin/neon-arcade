/**
 * TRIVIA — 1v1 + FFA quiz (SERVER-AUTHORITATIVE SCORING)
 * ======================================================
 * Ports the reference server's trivia loop with the anti-cheat fixes the
 * design contract demands (handoff §5):
 *
 * - correctAnswer NEVER leaves the server up front: `triviaGameStart` ships
 *   answerless questions; the answer is revealed per-question via
 *   `triviaAnswerResult` (to the answerer) and `triviaReveal` (to the room
 *   at the 15s deadline).
 * - `triviaAnswer` carries NO client timeLeft — the server scores against
 *   its own clock: points = ceil(remainingMs / 1000 * 10) on a correct
 *   answer (same curve the old client used, minus the spoofable input).
 * - One answer per player per question (dedup keyed by wallet + index) —
 *   the reference let clients stack points by re-answering.
 *
 * Matchmaking:
 * - 1v1: SKILL-based queue (nearest hidden mu, with a window that widens as
 *   you wait so nobody starves — see tryPair1v1); one slot per wallet
 *   (re-emitting findTriviaGame replaces the old entry); room
 *   `trivia-1v1-${gameId}`.
 * - FFA: join an open lobby-state game (< 100 players, inside its 5s fill
 *   window) else create one; the game starts 5s after creation PROVIDED at
 *   least FFA_MIN_PLAYERS humans are seated — online never means a solo quiz.
 *   A short-handed lobby stays open and fires the moment the roster fills.
 *   Joiners after start (late joiners) get a SOLO triviaGameStart including
 *   `currentQuestionIndex` so they drop in mid-quiz. Room
 *   `trivia-ffa-${gameId}`.
 * - EVERY join is acknowledged — `waiting` (legacy 1v1 ack) plus
 *   `queue:status { game:'trivia', mode, inQueue, current, needed }`, which
 *   also drives the client's live `PLAYERS n / N` counter. Duplicate joins
 *   and re-joins are acked too; silence is what froze the old lobby.
 *
 * Pacing (server-driven — clients never self-advance in multiplayer):
 * - 3s grace after triviaGameStart (the client runs a local 3s countdown),
 *   then 17s per question: 15s answer window + 2s reveal, advancing via
 *   `triviaNextQuestion { questionIndex }`.
 *
 * Scores are keyed by USERNAME (socket.data.username) — that is the
 * client's contract for the `triviaUpdate` scores record and the
 * `triviaEnded` winner string. Wallets stay server-side (global rule:
 * never leak wallets to opponents).
 *
 * RANK (Ranked 2.0, rankingLogic.md):
 * - 1v1 → rankService.settleRanked1v1 on the '1v1' ladder. An exact score tie
 *   is a real DRAW (TrueSkill's drawn outcome; RP only converges, it does not
 *   swing).
 * - FFA → rankService.settleRankedFfa on the 'ffa' ladder, mode label
 *   'quiz_ffa'. Placements are competition-ranked from the final score, so
 *   tied scores share a placement and rate as a draw between those players.
 *   Correct answers ride along in history as `kills` (handoff §6) — they do
 *   NOT feed the rating, which is outcome-only by design.
 */

import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import {
  generateQuestions,
  type GeneratedQuestion,
} from '../../services/questionGenerator'
// RANKED 2.0 — quiz 1v1 rides the '1v1' ladder, quiz FFA rides the 'ffa'
// ladder (shared with cells/asteroids slayer + lms; one rating pool for
// every free-for-all in the arcade).
import {
  getSkill,
  settleRanked1v1,
  settleRankedFfa,
  type RankedResult,
  type RankedStanding,
} from '../../services/rankService'
// eloService is now only the wire projection: it strips `wallet`, `mu` and
// `sigma` so a settlement result can be broadcast to a room.
import { publicRating, type PublicRating } from '../../services/eloService'
// Trivia keeps its own 1v1 waiting line (its pairing is entangled with the
// async question load) but reuses the shared skill-selection maths.
import {
  MATCH_RETRY_MS,
  pickSkillGroup,
  type SkillQueueEntry,
} from '../queue'
// Stats are written wherever the rating settles, guarded by the SAME
// teardown() (status flips to 'ended' before any await).
import { type RecordResultInput } from '../../services/statsService'
import { recordAndEmitProgression, type ProgressionEntry } from './progression'
import { MU_0 } from '../../services/trueskill'

// ---------------------------------------------------------------------------
// Tunables (design contract "Trivia" section)
// ---------------------------------------------------------------------------
const QUESTION_MS = 15_000 // answer window per question
const ROUND_MS = 17_000 // 15s answer + 2s reveal → advance cadence
const COUNTDOWN_MS = 3_000 // client-side 3s countdown after triviaGameStart
const FFA_FILL_MS = 5_000 // open-lobby fill window before an FFA game starts
const FFA_MAX_PLAYERS = 100
// Online means REAL opponents — never a solo quiz dressed up as a match. The
// FFA lobby therefore waits for at least this many humans; if the 5s fill
// window elapses short-handed the lobby simply stays open (and the client
// keeps showing PLAYERS n / N) until the second player arrives.
const FFA_MIN_PLAYERS = 2
const QUESTION_COUNT = 10
const GAME_KEY = 'trivia' // eloHistory.gameKey for both modes

// HARD CEILING on question generation. The OpenRouter call normally lands in
// 10-20s, but it has no transport timeout of its own: a hung provider used to
// leave BOTH matched players staring at the searching screen forever (observed
// live — the pair matched, `triviaGameStart` never arrived). Generous on
// purpose so the healthy path is untouched; it only catches a true hang, and
// the static LAST_RESORT_QUESTIONS set takes over so the match always starts.
const QUESTION_LOAD_TIMEOUT_MS = 45_000

// Topic pool for random selection — small hardcoded list per the design
// (mixes the reference server's neon-flavored topics with the lobby's
// general ones so multiplayer sets feel on-brand but varied).
const TRIVIA_TOPICS = [
  'Future Tech',
  'Space Exploration',
  'Gaming History',
  '80s Synthwave',
  'Science',
  'Pop Culture',
  'World History',
  'Movies & TV',
]

// ---------------------------------------------------------------------------
// LAST_RESORT_QUESTIONS — static fallback when generation fails
// ---------------------------------------------------------------------------
// The design forbids reading the client's TriviaQuestions.ts — these are a
// self-contained generic set so a dead OpenRouter key never blocks a match.
// Shape matches GeneratedQuestion (correctAnswer is the 0-3 option index).
const LAST_RESORT_QUESTIONS: GeneratedQuestion[] = [
  {
    question: 'Which planet is known as the Red Planet?',
    options: ['Venus', 'Mars', 'Jupiter', 'Mercury'],
    correctAnswer: 1,
    category: 'General Knowledge',
    difficulty: 'easy',
  },
  {
    question: 'How many bits are in a byte?',
    options: ['4', '8', '16', '32'],
    correctAnswer: 1,
    category: 'General Knowledge',
    difficulty: 'easy',
  },
  {
    question: 'What is the chemical symbol for gold?',
    options: ['Au', 'Ag', 'Gd', 'Go'],
    correctAnswer: 0,
    category: 'General Knowledge',
    difficulty: 'easy',
  },
  {
    question: 'Which company created the arcade classic Pac-Man?',
    options: ['Atari', 'Namco', 'Sega', 'Capcom'],
    correctAnswer: 1,
    category: 'General Knowledge',
    difficulty: 'medium',
  },
  {
    question: 'What does "CPU" stand for?',
    options: [
      'Central Processing Unit',
      'Computer Power Unit',
      'Core Program Utility',
      'Central Peripheral Unit',
    ],
    correctAnswer: 0,
    category: 'General Knowledge',
    difficulty: 'easy',
  },
  {
    question: 'Which is the largest ocean on Earth?',
    options: ['Atlantic', 'Indian', 'Pacific', 'Arctic'],
    correctAnswer: 2,
    category: 'General Knowledge',
    difficulty: 'easy',
  },
  {
    question: 'In which year did a human first walk on the Moon?',
    options: ['1965', '1969', '1972', '1959'],
    correctAnswer: 1,
    category: 'General Knowledge',
    difficulty: 'medium',
  },
  {
    question: 'Which programming language runs natively in web browsers?',
    options: ['Python', 'JavaScript', 'C++', 'Rust'],
    correctAnswer: 1,
    category: 'General Knowledge',
    difficulty: 'easy',
  },
  {
    question: 'Approximately how fast does light travel in a vacuum?',
    options: ['300,000 km/s', '150,000 km/s', '30,000 km/s', '3,000,000 km/s'],
    correctAnswer: 0,
    category: 'General Knowledge',
    difficulty: 'medium',
  },
  {
    question: 'Which gas do plants primarily absorb for photosynthesis?',
    options: ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen'],
    correctAnswer: 2,
    category: 'General Knowledge',
    difficulty: 'easy',
  },
]

// ---------------------------------------------------------------------------
// Zod schemas — every inbound payload is safeParse'd; failures are ignored
// ---------------------------------------------------------------------------
// `profile` is cosmetic-only: we take avatarUrl and NOTHING else. Identity
// (wallet + username) comes exclusively from socket.data (handshake auth).
// Unknown keys (the client sends its whole profile) are stripped by zod.
const FindTriviaGameSchema = z.object({
  profile: z
    .object({ avatarUrl: z.string().max(500).nullish() })
    .nullish(),
  config: z.object({ mode: z.enum(['1v1', 'ffa']) }),
})

// NOTE: the legacy client also sends `timeLeft` here — deliberately absent
// from the schema (non-strict objects strip unknown keys), so a spoofed
// timeLeft simply never reaches scoring. answerIndex -1 = "no answer".
const TriviaAnswerSchema = z.object({
  gameId: z.string().uuid(),
  answerIndex: z.number().int().min(-1).max(3),
})

// ---------------------------------------------------------------------------
// In-memory state (module-scope registries, per matchmaking conventions)
// ---------------------------------------------------------------------------
/**
 * A player in the 1v1 waiting line. `mu` (hidden skill) and `joinedAt` are
 * what the skill matcher pairs on — both are SERVER-ONLY and never emitted.
 * The FFA path builds one of these too, but only ever reads the identity
 * fields (an FFA lobby seats whoever shows up; there is nothing to pair).
 */
interface QueueEntry extends SkillQueueEntry {
  socket: Socket
  wallet: string
  name: string // socket.data.username — the canonical display name
  avatarUrl: string | null
}

interface TriviaPlayer {
  socketId: string
  wallet: string // server-side only — NEVER serialized to clients
  name: string
  avatarUrl: string | null
  correctCount: number // FFA: substitutes kills in eloHistory (handoff §6)
}

interface LoadedQuestions {
  topic: string
  questions: GeneratedQuestion[]
}

interface TriviaGame {
  gameId: string
  room: string // trivia-1v1-${gameId} | trivia-ffa-${gameId}
  mode: '1v1' | 'ffa'
  // lobby  = created, questions generating / FFA fill window open
  // active = triviaGameStart broadcast, quiz running (or in 3s countdown)
  // ended  = settled/torn down (guards double-settlement)
  status: 'lobby' | 'active' | 'ended'
  topic: string
  questions: GeneratedQuestion[] // WITH answers — server-side only
  players: TriviaPlayer[]
  scores: Record<string, number> // keyed by username (client contract)
  currentQuestionIndex: number
  questionStartAt: number | null // server clock; null until Q0 begins
  answered: Set<string> // dedup keys `${wallet}:${questionIndex}`
  createdAt: number
  questionsPromise: Promise<LoadedQuestions> | null // FFA: overlaps fill window
  // FFA: the 5s fill window has run out. Once true the game starts as soon as
  // FFA_MIN_PLAYERS are seated (instead of waiting for another timer).
  fillWindowElapsed: boolean
  startTimer: ReturnType<typeof setTimeout> | null // FFA 5s fill window
  countdownTimer: ReturnType<typeof setTimeout> | null // 3s client countdown
  revealTimer: ReturnType<typeof setTimeout> | null // per-question 15s reveal
  loopTimer: ReturnType<typeof setInterval> | null // 17s advance loop
}

/**
 * What `newRatings` looks like on the wire.
 *   1v1 → `{ a, b }`, the same two-key shape the shipped client already reads
 *   FFA → one entry per rated player, ordered by placement
 * Both are `PublicRating`s: wallet/mu/sigma are stripped, and the legacy
 * `rating`/`change` keys are still there so an un-migrated client renders
 * unchanged. null = the game was not rated (no DB / not enough players).
 */
type NewRatings = { a: PublicRating; b: PublicRating } | PublicRating[] | null

/** The 1v1 waiting line. Pairing is by SKILL (see tryPair1v1), not arrival. */
const waiting1v1: QueueEntry[] = []

/** Anti-starvation heartbeat for the 1v1 line — the acceptable skill window
 *  widens with wall-clock time, so an idle-but-mismatched queue needs a tick
 *  to be re-considered. Unref'd; armed only while 2+ players wait. */
let retryTimer: ReturnType<typeof setTimeout> | null = null
const games = new Map<string, TriviaGame>()

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Pick a random topic and generate 10 mixed-difficulty questions; on ANY
 *  failure fall back to the static set (topic relabeled to match it). */
async function loadQuestions(): Promise<LoadedQuestions> {
  const topic =
    TRIVIA_TOPICS[Math.floor(Math.random() * TRIVIA_TOPICS.length)] ??
    'General Knowledge'
  try {
    // Race the generator against QUESTION_LOAD_TIMEOUT_MS. `null` means the
    // ceiling won: we drop the (possibly still pending) call and start the
    // match on the static set rather than freezing two matched players.
    const questions = await Promise.race([
      generateQuestions({ topic, count: QUESTION_COUNT, difficulty: 'mixed' }),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), QUESTION_LOAD_TIMEOUT_MS)
      ),
    ])
    if (questions === null) {
      console.error(
        `[trivia] question generation exceeded ${QUESTION_LOAD_TIMEOUT_MS}ms — using fallback`
      )
    } else if (questions.length > 0) {
      return { topic, questions }
    }
  } catch (err) {
    console.error('[trivia] question generation failed — using fallback:', err)
  }
  return { topic: 'General Knowledge', questions: LAST_RESORT_QUESTIONS }
}

/** ANTI-CHEAT: the question set sent to clients — correctAnswer removed. */
function stripQuestions(questions: GeneratedQuestion[]) {
  return questions.map(({ question, options, category, difficulty }) => ({
    question,
    options,
    category,
    difficulty,
  }))
}

/** Player list safe to broadcast: socketId is fine, wallet is NOT. */
function publicPlayers(game: TriviaGame) {
  return game.players.map((p) => ({
    socketId: p.socketId,
    name: p.name,
    avatarUrl: p.avatarUrl,
    score: game.scores[p.name] ?? 0,
  }))
}

/** The triviaGameStart payload (late joiners add currentQuestionIndex). */
function startPayload(game: TriviaGame) {
  return {
    gameId: game.gameId,
    topic: game.topic,
    questions: stripQuestions(game.questions),
    players: publicPlayers(game),
  }
}

function clearTimers(game: TriviaGame) {
  if (game.startTimer) clearTimeout(game.startTimer)
  if (game.countdownTimer) clearTimeout(game.countdownTimer)
  if (game.revealTimer) clearTimeout(game.revealTimer)
  if (game.loopTimer) clearInterval(game.loopTimer)
  game.startTimer = game.countdownTimer = game.revealTimer = null
  game.loopTimer = null
}

/** Stop everything and forget the game (no events — callers emit first
 *  if anyone is left to hear them). */
function teardown(game: TriviaGame) {
  game.status = 'ended'
  clearTimers(game)
  games.delete(game.gameId)
}

// ---------------------------------------------------------------------------
// Queue acknowledgement — ALWAYS emitted, never silent
// ---------------------------------------------------------------------------
// The client shows SEARCHING FOR ONLINE MATCH the moment it is clicked, so
// these events are confirmation + the live `PLAYERS n / N` counter, not the
// trigger. Crucially they are sent on EVERY join, duplicates included: the
// old "already seated / already queued" paths returned silently, which left a
// re-joining client with no reply at all.

/** One-shot ack to a single socket (1v1 queue, or a confirmed join). */
function emitQueueStatusTo(
  socket: Socket,
  mode: '1v1' | 'ffa',
  inQueue: boolean,
  current: number,
  needed: number
) {
  socket.emit('queue:status', {
    game: 'trivia',
    mode,
    inQueue,
    current,
    needed,
  })
}

/** "You are out of every trivia queue" — mode-agnostic on purpose: a leave
 *  can arrive from the 1v1 line or an FFA lobby seat. */
function emitLeftQueue(socket: Socket) {
  socket.emit('queue:status', {
    game: 'trivia',
    inQueue: false,
    current: 0,
    needed: 0,
  })
}

/** Roster broadcast for an FFA lobby — every waiting player sees the count
 *  tick up as others arrive. No-op once the quiz is running. */
function emitFfaQueueStatus(io: Server, game: TriviaGame) {
  if (game.status !== 'lobby') return
  io.to(game.room).emit('queue:status', {
    game: 'trivia',
    mode: 'ffa',
    inQueue: true,
    current: game.players.length,
    needed: FFA_MIN_PLAYERS,
  })
}

/** Room-wide score refresh — after every accepted answer and on FFA leave.
 *  `scores` is the name-keyed record the 1v1 HUD reads; `players` is the
 *  (sorted) array the FFA leaderboard slices. */
function emitUpdate(io: Server, game: TriviaGame) {
  const players = game.players
    .map((p) => ({ name: p.name, score: game.scores[p.name] ?? 0 }))
    .sort((a, b) => b.score - a.score)
  io.to(game.room).emit('triviaUpdate', { scores: game.scores, players })
}

// ---------------------------------------------------------------------------
// Pacing loop (server-driven)
// ---------------------------------------------------------------------------

/** Arm one question: stamp the server-clock start time and schedule the
 *  15s reveal so players who never answered still see the right option. */
function beginQuestion(io: Server, game: TriviaGame) {
  game.questionStartAt = Date.now()
  if (game.revealTimer) clearTimeout(game.revealTimer) // already fired; hygiene
  game.revealTimer = setTimeout(() => {
    const q = game.questions[game.currentQuestionIndex]
    if (!q || game.status !== 'active') return
    io.to(game.room).emit('triviaReveal', {
      questionIndex: game.currentQuestionIndex,
      correctAnswer: q.correctAnswer,
    })
  }, QUESTION_MS)
}

/** 17s tick: move to the next question or finish the quiz. */
function advance(io: Server, game: TriviaGame) {
  game.currentQuestionIndex++
  if (game.currentQuestionIndex >= game.questions.length) {
    void endGame(io, game)
    return
  }
  io.to(game.room).emit('triviaNextQuestion', {
    questionIndex: game.currentQuestionIndex,
  })
  beginQuestion(io, game)
}

/** Fire the quiz after the client's 3s countdown: question 0 starts now,
 *  then the fixed 17s advance cadence (15s answer + 2s reveal). */
function beginLoop(io: Server, game: TriviaGame) {
  if (game.status !== 'active') return
  beginQuestion(io, game)
  game.loopTimer = setInterval(() => advance(io, game), ROUND_MS)
}

/** Broadcast triviaGameStart to the room and schedule the loop start.
 *  Status flips to 'active' here — this is what closes an FFA lobby. */
function broadcastStart(io: Server, game: TriviaGame) {
  game.status = 'active'
  io.to(game.room).emit('triviaGameStart', startPayload(game))
  game.countdownTimer = setTimeout(() => beginLoop(io, game), COUNTDOWN_MS)
}

// ---------------------------------------------------------------------------
// Game end + settlement
// ---------------------------------------------------------------------------

/**
 * STATS helper — one `match_results` row per player of a finished quiz.
 *
 * Trivia is NOT a K/D game (the contract's K/D list is pug shooter,
 * asteroids and cells), so `kills` stays 0 on purpose: correct answers
 * substitute for kills in eloHistory only. Writing them here would inflate
 * the player's combined K/D with a game that has no deaths at all.
 *
 * `score` is the quiz score; FFA rows also carry a 1-based placement
 * computed with competition ranking (ties share a place), which is the same
 * rule rankService uses. Only usernames are stored — never a wallet.
 */
function recordTriviaResults(
  io: Server,
  game: TriviaGame,
  /** Forfeit path: this wallet WON regardless of score (the opponent left);
   *  everyone else loses. Omitted for a natural end. */
  forcedWinnerWallet?: string,
  /** Raw settle results keyed by wallet, so each player's own rank change
   *  can ride out on their `match:progression` event. Null when unrated. */
  rankedByWallet?: Map<string, RankedResult> | null
): void {
  const durationMs = Date.now() - game.createdAt
  const entries = game.players.map((p) => ({
    player: p,
    score: game.scores[p.name] ?? 0,
  }))
  if (entries.length === 0) return

  // Competition ranking: placement = 1 + (# players with a strictly better
  // score). 1v1 uses it too, which is what makes a tie a draw for both.
  const placementOf = (score: number): number =>
    1 + entries.filter((e) => e.score > score).length

  // A 1v1 (or a 2-player FFA) can name its opponent; a bigger field cannot
  // be represented by a single username, so it stays null.
  const opponentOf = (wallet: string): string | null =>
    entries.length === 2
      ? (entries.find((e) => e.player.wallet !== wallet)?.player.name ?? null)
      : null

  const progression: ProgressionEntry[] = entries.map(({ player, score }) => {
    // Forfeit: the survivor wins outright, the leaver takes the loss — the
    // scoreboard has no say (it mirrors settleRanked1v1(survivor, leaver, 'a')).
    const isForfeit = forcedWinnerWallet !== undefined
    const placement = isForfeit
      ? player.wallet === forcedWinnerWallet
        ? 1
        : 2
      : placementOf(score)
    // Sharing first place = a draw; otherwise 1st wins and the rest lose.
    const tiedForFirst =
      !isForfeit &&
      placement === 1 &&
      entries.filter((e) => placementOf(e.score) === 1).length > 1
    const input: RecordResultInput = {
      // gameId is a uuid, and match_results.matchId is deliberately NOT a
      // foreign key — it just groups the rows of one quiz together.
      matchId: game.gameId,
      wallet: player.wallet,
      gameKey: GAME_KEY,
      mode: game.mode, // '1v1' | 'ffa'
      result: tiedForFirst ? 'draw' : placement === 1 ? 'win' : 'loss',
      score,
      // Placement is only meaningful for a field; a 1v1 has win/loss/draw.
      placement: game.mode === 'ffa' ? placement : null,
      opponentUsername: opponentOf(player.wallet),
      durationMs,
    }
    return {
      socketId: player.socketId,
      input,
      ranked: rankedByWallet?.get(player.wallet) ?? null,
    }
  })

  // Same stats write as the old recordResults batch (one row per player),
  // plus each player's XP award and rank change delivered to their own
  // socket as `match:progression`. Fire-and-forget; never throws.
  void recordAndEmitProgression(io, GAME_KEY, progression)
}

/** Natural end (last question elapsed). Settles ELO and broadcasts
 *  triviaEnded. Torn down BEFORE the async settle so a concurrent
 *  disconnect can't double-settle. */
async function endGame(io: Server, game: TriviaGame) {
  if (game.status === 'ended') return
  teardown(game)

  // Results come from the scores record (NOT players[]) so FFA leavers —
  // whose score entries are deliberately kept — still show on the board.
  const results = Object.entries(game.scores)
    .map(([name, score]) => ({ name, score }))
    .sort((a, b) => b.score - a.score)
  const winner = results[0]?.name ?? ''

  let newRatings: NewRatings = null
  // Raw settle results keyed by wallet — recordTriviaResults hands each
  // player their OWN entry on the `match:progression` event.
  let rankedByWallet: Map<string, RankedResult> | null = null
  if (game.mode === '1v1' && game.players.length === 2) {
    const [a, b] = game.players
    const scoreA = game.scores[a.name] ?? 0
    const scoreB = game.scores[b.name] ?? 0
    // Score tie → a genuine DRAW: TrueSkill's drawn update, and RP moves only
    // toward skill rather than swinging (never skipped, per contract).
    const result = scoreA === scoreB ? 'draw' : scoreA > scoreB ? 'a' : 'b'
    // `game.gameId` is the SAME id recordTriviaResults writes, so
    // elo_history and match_results are joinable (non-uuids are dropped).
    const settled = await settleRanked1v1(
      GAME_KEY,
      a.wallet,
      b.wallet,
      result,
      game.gameId
    )
    if (settled) {
      newRatings = { a: publicRating(settled.a), b: publicRating(settled.b) }
      rankedByWallet = new Map([
        [settled.a.wallet, settled.a],
        [settled.b.wallet, settled.b],
      ])
    }
  } else if (game.mode === 'ffa') {
    // Only still-connected players get rated (leavers forfeit — we no
    // longer hold a live seat for them, but their score stays in results).
    // Placements are derived from `score` with competition ranking inside
    // settleRankedFfa, so an exact score tie shares a placement and both
    // players are rated as having drawn with each other.
    const standings: RankedStanding[] = game.players.map((p) => ({
      wallet: p.wallet,
      score: game.scores[p.name] ?? 0,
      kills: p.correctCount, // correct answers stand in for kills in history
    }))
    const settled = await settleRankedFfa(
      GAME_KEY,
      standings,
      game.gameId, // same id as the stats rows -> the two tables join
      'quiz_ffa'
    )
    // publicRating strips wallet AND the hidden mu/sigma before broadcast.
    newRatings = settled ? settled.map(publicRating) : null
    if (settled) {
      rankedByWallet = new Map(settled.map((r) => [r.wallet, r]))
    }
  }

  // STATS — recorded for exactly the endings that settle (teardown() above
  // already flipped the status, so this can never run twice for one game).
  // Note it does NOT depend on settle* succeeding: a quiz played without a
  // database still deserves its history row when the DB comes back… and when
  // there is no DB at all, recordResults is a no-op anyway.
  // The 2-player floor mirrors settleFfa's own "need a field to rate against"
  // rule, so a lobby that emptied out can't hand its last player a free win.
  if (
    (game.mode === '1v1' && game.players.length === 2) ||
    (game.mode === 'ffa' && game.players.length >= 2)
  ) {
    recordTriviaResults(io, game, undefined, rankedByWallet)
  }

  io.to(game.room).emit('triviaEnded', { winner, results, newRatings })
  io.in(game.room).socketsLeave(game.room)
}

/** 1v1 disconnect: the remaining player wins. ELO settles only if the game
 *  actually started ('active') — a lobby-phase abort (opponent left while
 *  questions were still generating) ends unrated. */
async function endByOpponentLeft(
  io: Server,
  game: TriviaGame,
  leaverWallet: string
) {
  if (game.status === 'ended') return
  const wasActive = game.status === 'active'
  teardown(game) // stop timers + guard double-settlement BEFORE awaiting

  const survivor = game.players.find((p) => p.wallet !== leaverWallet)
  const leaver = game.players.find((p) => p.wallet === leaverWallet)

  const results = Object.entries(game.scores)
    .map(([name, score]) => ({ name, score }))
    .sort((a, b) => b.score - a.score)

  let newRatings: NewRatings = null
  if (wasActive && survivor && leaver) {
    const settled = await settleRanked1v1(
      GAME_KEY,
      survivor.wallet,
      leaver.wallet,
      'a', // the survivor wins outright; walking away is a loss
      game.gameId // same id as the stats rows -> the two tables join
    )
    if (settled) {
      newRatings = { a: publicRating(settled.a), b: publicRating(settled.b) }
    }
    // STATS — same condition as settlement: a lobby-phase abort (questions
    // still generating) is not a played match and records nothing.
    recordTriviaResults(
      io,
      game,
      survivor.wallet,
      settled
        ? new Map([
            [settled.a.wallet, settled.a],
            [settled.b.wallet, settled.b],
          ])
        : null
    )
  }

  io.to(game.room).emit('triviaEnded', {
    winner: survivor?.name ?? '',
    results,
    newRatings,
    reason: 'opponent_left',
  })
  io.in(game.room).socketsLeave(game.room)
}

/** FFA leave (disconnect or lobby abort): drop the seat but KEEP the score
 *  entry (contract: scores are keyed by name and survive a leave). An
 *  emptied game is torn down silently. */
function removeFfaPlayer(io: Server, game: TriviaGame, wallet: string) {
  const idx = game.players.findIndex((p) => p.wallet === wallet)
  if (idx === -1) return
  game.players.splice(idx, 1)
  if (game.players.length === 0) {
    teardown(game) // nobody left to play or to hear an ending
    return
  }
  if (game.status === 'active') emitUpdate(io, game) // refresh leaderboards
  else emitFfaQueueStatus(io, game) // still filling → counter ticks back down
}

// ---------------------------------------------------------------------------
// Matchmaking — 1v1 pairing + FFA lobby/create/late-join
// ---------------------------------------------------------------------------

function toPlayer(entry: QueueEntry): TriviaPlayer {
  return {
    socketId: entry.socket.id,
    wallet: entry.wallet,
    name: entry.name,
    avatarUrl: entry.avatarUrl,
    correctCount: 0,
  }
}

function makeGame(mode: '1v1' | 'ffa'): TriviaGame {
  const gameId = crypto.randomUUID()
  return {
    gameId,
    room: `trivia-${mode}-${gameId}`,
    mode,
    status: 'lobby',
    topic: '',
    questions: [],
    players: [],
    scores: {},
    currentQuestionIndex: 0,
    questionStartAt: null,
    answered: new Set(),
    createdAt: Date.now(),
    questionsPromise: null,
    fillWindowElapsed: false,
    startTimer: null,
    countdownTimer: null,
    revealTimer: null,
    loopTimer: null,
  }
}

/** Pair two queue entries into a 1v1 game. The game is registered (and the
 *  sockets are in the room) BEFORE the async question load, so disconnect
 *  cleanup can find it mid-generation; after the await we re-check that
 *  nothing tore it down in the meantime. */
async function start1v1(io: Server, first: QueueEntry, second: QueueEntry) {
  const game = makeGame('1v1')
  game.players = [toPlayer(first), toPlayer(second)]
  game.scores = { [first.name]: 0, [second.name]: 0 }
  games.set(game.gameId, game)
  first.socket.join(game.room)
  second.socket.join(game.room)

  // The opponent is already locked in, but `triviaGameStart` cannot go out
  // until the questions exist (10-20s of LLM latency). Tell the clients NOW so
  // the shared searching screen can say "opponent found — preparing questions"
  // instead of implying we are still hunting for a human.
  io.to(game.room).emit('triviaMatched', {
    mode: game.mode,
    players: publicPlayers(game),
  })

  const loaded = await loadQuestions()
  // A disconnect during generation ends the game via endByOpponentLeft —
  // don't resurrect it.
  if (games.get(game.gameId) !== game || game.status !== 'lobby') return
  game.topic = loaded.topic
  game.questions = loaded.questions
  broadcastStart(io, game)
}

/** Seat one player in an FFA game (lobby or active) and prime their score. */
function addFfaPlayer(game: TriviaGame, entry: QueueEntry) {
  game.players.push(toPlayer(entry))
  // ??= keeps an existing entry if the same username left and came back.
  game.scores[entry.name] ??= 0
  entry.socket.join(game.room)
}

/** Launch an FFA lobby that has enough humans in it. Safe to call more than
 *  once — every exit path re-checks the lobby is still startable. */
async function startFfaNow(io: Server, game: TriviaGame) {
  if (game.status !== 'lobby') return
  if (game.players.length < FFA_MIN_PLAYERS) return
  // Roster is final — same "matched, questions loading" signal as 1v1.
  io.to(game.room).emit('triviaMatched', {
    mode: game.mode,
    players: publicPlayers(game),
  })
  const loaded = await (game.questionsPromise ?? loadQuestions())
  // Players may have bailed (or teardown run) while questions loaded.
  if (games.get(game.gameId) !== game || game.status !== 'lobby') return
  if (game.players.length < FFA_MIN_PLAYERS) return
  game.topic = loaded.topic
  game.questions = loaded.questions
  broadcastStart(io, game)
}

/** Create a fresh FFA game: question generation kicks off IMMEDIATELY so
 *  the LLM latency overlaps the 5s fill window instead of adding to it. */
function createFfa(io: Server, entry: QueueEntry) {
  const game = makeGame('ffa')
  games.set(game.gameId, game)
  addFfaPlayer(game, entry)
  emitFfaQueueStatus(io, game) // PLAYERS 1 / 2

  game.questionsPromise = loadQuestions() // never rejects (falls back)
  game.startTimer = setTimeout(() => {
    if (games.get(game.gameId) !== game || game.status !== 'lobby') return
    game.fillWindowElapsed = true
    if (game.players.length === 0) {
      teardown(game) // nobody waiting — nothing to keep alive
      return
    }
    // Short-handed (the common case: one player waiting alone)? Stay in the
    // lobby. joinFfa starts the quiz the moment the roster is big enough.
    void startFfaNow(io, game)
  }, FFA_FILL_MS)
}

/** FFA entry point: rebind if already seated, join an open lobby, late-join
 *  an active game, or create a new one — in that order. */
function joinFfa(io: Server, entry: QueueEntry) {
  // Already seated (re-emitted findTriviaGame / reconnected with a new
  // socket)? Rebind the seat to this socket and resend state if running.
  for (const game of games.values()) {
    if (game.mode !== 'ffa' || game.status === 'ended') continue
    const existing = game.players.find((p) => p.wallet === entry.wallet)
    if (existing) {
      existing.socketId = entry.socket.id
      existing.avatarUrl = entry.avatarUrl
      entry.socket.join(game.room)
      if (game.status === 'active') {
        entry.socket.emit('triviaGameStart', {
          ...startPayload(game),
          currentQuestionIndex: game.currentQuestionIndex,
        })
      } else {
        // Still filling: re-ack instead of returning silently (this was the
        // duplicate-join dead end that froze the client on the lobby).
        emitQueueStatusTo(
          entry.socket,
          'ffa',
          true,
          game.players.length,
          FFA_MIN_PLAYERS
        )
      }
      return
    }
  }

  // Open lobby → join it. 'lobby' status means one of two things: the 5s
  // fill window is still running, OR it ran out while the lobby was short of
  // FFA_MIN_PLAYERS and is now simply waiting for humans. Both are joinable,
  // and the second case starts the quiz immediately below.
  for (const game of games.values()) {
    if (
      game.mode === 'ffa' &&
      game.status === 'lobby' &&
      game.players.length < FFA_MAX_PLAYERS
    ) {
      addFfaPlayer(game, entry)
      emitFfaQueueStatus(io, game) // everyone waiting sees PLAYERS n / N tick
      // The fill window may already have elapsed while this lobby waited
      // short-handed — in that case the newcomer starts the quiz.
      if (game.fillWindowElapsed) void startFfaNow(io, game)
      return
    }
  }

  // Running game with a free seat → late-join: solo start payload with
  // currentQuestionIndex so the client drops into the current question.
  for (const game of games.values()) {
    if (
      game.mode === 'ffa' &&
      game.status === 'active' &&
      game.players.length < FFA_MAX_PLAYERS
    ) {
      addFfaPlayer(game, entry)
      entry.socket.emit('triviaGameStart', {
        ...startPayload(game),
        currentQuestionIndex: game.currentQuestionIndex,
      })
      emitUpdate(io, game) // everyone else learns about the newcomer
      return
    }
  }

  // Nothing joinable → open a new lobby.
  createFfa(io, entry)
}

/** Drop queue entries matching a predicate (wallet replace / disconnect). */
function removeQueueWhere(pred: (e: QueueEntry) => boolean) {
  for (let i = waiting1v1.length - 1; i >= 0; i--) {
    if (pred(waiting1v1[i])) waiting1v1.splice(i, 1)
  }
}

/**
 * Try to start one 1v1 quiz out of the waiting line — by SKILL, not by
 * arrival order (rankingLogic.md §5.3).
 *
 * `pickSkillGroup` returns the pair with the smallest hidden-skill gap that
 * BOTH players currently accept; the accepted gap widens the longer someone
 * waits and is unbounded after ~30s, so a lone high-rated player is never
 * stranded. The pair comes back in FIFO order, so the longest waiter is still
 * listed first — which start1v1 uses for the roster order.
 *
 * Returns true when a game was started.
 */
function tryPair1v1(io: Server, now: number = Date.now()): boolean {
  // Prune corpses first (disconnect cleanup should already have — defensive).
  for (let i = waiting1v1.length - 1; i >= 0; i--) {
    if (!waiting1v1[i].socket.connected) waiting1v1.splice(i, 1)
  }

  const pair = pickSkillGroup(waiting1v1, 2, now)
  if (!pair) return false

  const [first, second] = pair
  if (first.wallet === second.wallet) {
    // One slot per wallet is enforced on join, so this cannot happen — but a
    // self-match would be unrateable, so drop the newer entry and bail.
    removeQueueWhere((e) => e.socket.id === second.socket.id)
    return false
  }

  // Commit: both leave the line before anything is emitted.
  removeQueueWhere(
    (e) => e.socket.id === first.socket.id || e.socket.id === second.socket.id
  )

  // Both sides leave the queue here; triviaGameStart follows once the
  // questions land (start1v1 emits `triviaMatched` in the meantime).
  emitLeftQueue(first.socket)
  emitLeftQueue(second.socket)
  void start1v1(io, first, second) // longest waiter listed first
  return true
}

/** Arm the anti-starvation re-check while two or more players are waiting. */
function scheduleRetry1v1(io: Server): void {
  if (retryTimer) return
  if (waiting1v1.length < 2) return
  const timer = setTimeout(() => {
    retryTimer = null
    tryPair1v1(io)
    scheduleRetry1v1(io)
  }, MATCH_RETRY_MS)
  ;(timer as { unref?: () => void }).unref?.()
  retryTimer = timer
}

// ---------------------------------------------------------------------------
// registerTrivia — wires this socket's trivia events + its own disconnect
// ---------------------------------------------------------------------------
export function registerTrivia(io: Server, socket: Socket) {
  // findTriviaGame { profile?, config: { mode: '1v1'|'ffa' } }
  socket.on('findTriviaGame', async (raw) => {
    const parsed = FindTriviaGameSchema.safeParse(raw)
    if (!parsed.success) return // silently ignore malformed payloads

    // Identity comes ONLY from the authenticated handshake.
    const wallet: string = socket.data.wallet
    const username: string | null = socket.data.username ?? null
    if (!username) {
      // Games require a registered account (design: handshake auth section).
      socket.emit('gameAuthError', {
        code: 'no_account',
        message: 'Finish account setup to play online',
      })
      return
    }

    const entry: QueueEntry = {
      socket,
      wallet,
      name: username,
      avatarUrl: parsed.data.profile?.avatarUrl ?? null, // cosmetic only
      // Filled in below for the 1v1 path (the FFA lobby seats whoever shows
      // up, so it never pairs and never needs a skill lookup).
      mu: MU_0,
      joinedAt: Date.now(),
    }

    if (parsed.data.config.mode === '1v1') {
      // HIDDEN SKILL SNAPSHOT for the matcher. Taken FIRST so that everything
      // from "pushed into the line" to "paired" stays synchronous — no await
      // window in which a disconnect could strand a half-built match.
      // getSkill never throws and always resolves (defaults when there is no
      // row / no DB), so matchmaking degrades gracefully instead of failing.
      const skill = await getSkill(wallet, '1v1')
      if (socket.disconnected) return // gave up during the lookup
      entry.mu = skill.mu
      // A re-join replaces the slot but CARRIES THE ORIGINAL WAIT CLOCK
      // FORWARD — otherwise a client that re-emits findTriviaGame on every
      // remount would keep resetting its own acceptance window and could
      // never widen out of a narrow skill band.
      entry.joinedAt =
        waiting1v1.find((e) => e.wallet === wallet)?.joinedAt ?? Date.now()

      // ALREADY SEATED IN A LIVE 1v1? Do not queue again — that would build a
      // SECOND game and orphan the first (its rank and stats would never
      // settle). Rebind the seat to this socket and resend the state instead,
      // exactly as joinFfa does for FFA. Re-checked AFTER the await above, so
      // a concurrent findTriviaGame can't seat us while the lookup ran.
      //
      // This is not theoretical: the private-wager start (socket/games/
      // privateMatch.ts) dispatches `findTriviaGame` on the player's behalf,
      // and the trivia screen the client then mounts emits its own. Connect
      // already guarded this case; trivia did not.
      for (const game of games.values()) {
        if (game.mode !== '1v1' || game.status === 'ended') continue
        const seat = game.players.find((p) => p.wallet === wallet)
        if (!seat) continue
        seat.socketId = socket.id
        seat.avatarUrl = parsed.data.profile?.avatarUrl ?? seat.avatarUrl
        socket.join(game.room)
        emitLeftQueue(socket) // we are playing, not queuing
        if (game.status === 'active') {
          socket.emit('triviaGameStart', {
            ...startPayload(game),
            currentQuestionIndex: game.currentQuestionIndex,
          })
        }
        // status 'lobby' = questions are still generating; the normal
        // triviaGameStart broadcast is already coming to this room.
        return
      }

      // One queue slot per wallet — re-emitting replaces the old entry.
      removeQueueWhere((e) => e.wallet === wallet)
      waiting1v1.push(entry)

      // Pair on SKILL. tryPair1v1 emits the queue-left acks for whoever it
      // seats, so only a player still WAITING needs the queued ack below.
      tryPair1v1(io)

      if (waiting1v1.some((e) => e.socket.id === socket.id)) {
        // ALWAYS acked — including a re-join that just replaced its own slot,
        // which is exactly the case the old code answered with silence. (Skill
        // pairing can also seat two OTHER players and leave this one waiting;
        // this branch reports that honestly rather than faking a match.)
        socket.emit('waiting', 'Waiting for opponent...') // legacy ack
        emitQueueStatusTo(socket, '1v1', true, 1, 2)
      }
      scheduleRetry1v1(io) // self-guards when fewer than two are left
    } else {
      joinFfa(io, entry)
    }
  })

  // triviaAnswer { gameId, answerIndex } — NO client timeLeft accepted.
  socket.on('triviaAnswer', (raw) => {
    const parsed = TriviaAnswerSchema.safeParse(raw)
    if (!parsed.success) return
    const { gameId, answerIndex } = parsed.data

    const game = games.get(gameId)
    if (!game || game.status !== 'active' || game.questionStartAt === null) {
      return // no game / countdown still running → nothing to score
    }

    const wallet: string = socket.data.wallet
    const player = game.players.find((p) => p.wallet === wallet)
    if (!player) return // not a participant of this game

    const now = Date.now()
    // An answer stamped before the question began can only come from a
    // desynced or cheating client — ignore it.
    if (now < game.questionStartAt) return

    const qIndex = game.currentQuestionIndex
    const question = game.questions[qIndex]
    if (!question) return

    // DEDUP: first answer per player per question wins; repeats are void.
    // NOTE: without a questionIndex on the wire (client contract), a >2s-
    // late answer lands on the NEXT question — dedup still caps it at one
    // answer per question, so there is nothing to farm.
    const dedupKey = `${wallet}:${qIndex}`
    if (game.answered.has(dedupKey)) return
    game.answered.add(dedupKey)

    // SERVER-CLOCK SCORING: remaining time on OUR clock, not the client's.
    // ceil(remainingMs / 1000 * 10) reproduces the old ceil(timeLeft * 10)
    // curve (max 150/question) minus the spoofable input. Answers landing
    // in the 2s reveal window score 0 but still get their result event.
    const remainingMs = Math.max(0, QUESTION_MS - (now - game.questionStartAt))
    const correct = answerIndex === question.correctAnswer
    const points = correct ? Math.ceil((remainingMs / 1000) * 10) : 0

    if (correct) {
      player.correctCount += 1
      game.scores[player.name] = (game.scores[player.name] ?? 0) + points
    }

    // The reveal goes to the SENDER only — the room learns the answer at
    // the 15s deadline via triviaReveal.
    socket.emit('triviaAnswerResult', {
      questionIndex: qIndex,
      correct,
      correctAnswer: question.correctAnswer,
      points,
    })
    emitUpdate(io, game)
  })

  // leaveTriviaQueue — no payload. Covers both "queues": the 1v1 waiting
  // line AND a not-yet-started FFA lobby seat (the Abort Link button fires
  // this from the waiting screen in either mode).
  socket.on('leaveTriviaQueue', () => {
    const wallet: string = socket.data.wallet
    removeQueueWhere((e) => e.socket.id === socket.id)
    for (const game of [...games.values()]) {
      if (game.mode === 'ffa' && game.status === 'lobby') {
        const seated = game.players.some(
          (p) => p.wallet === wallet && p.socketId === socket.id
        )
        if (seated) {
          removeFfaPlayer(io, game, wallet)
          socket.leave(game.room)
        }
      }
    }
    // Idempotent + always acked: the client fires this from CANCEL and again
    // from its unmount cleanup, and both must leave us dequeued.
    emitLeftQueue(socket)
  })

  // Disconnect cleanup — OWN handler per module (design: no central loop).
  socket.on('disconnect', () => {
    const wallet: string = socket.data.wallet

    // Queue: drop this socket's entry (match by socket id, not wallet, so
    // a fresh connection's replacement entry is never collateral damage).
    removeQueueWhere((e) => e.socket.id === socket.id)

    // Games: only act where THIS socket holds the seat (an FFA rejoin may
    // have rebound the seat to a newer socket — that seat must survive).
    for (const game of [...games.values()]) {
      const seated = game.players.some(
        (p) => p.wallet === wallet && p.socketId === socket.id
      )
      if (!seated) continue
      if (game.mode === '1v1') {
        void endByOpponentLeft(io, game, wallet) // survivor wins (+ELO if active)
      } else {
        removeFfaPlayer(io, game, wallet) // seat freed, score entry kept
      }
    }
  })
}
