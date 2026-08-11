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
 * - 1v1: FIFO queue (shift, not the ref's LIFO pop); one slot per wallet
 *   (re-emitting findTriviaGame replaces the old entry); room
 *   `trivia-1v1-${gameId}`.
 * - FFA: join an open lobby-state game (< 100 players, inside its 5s fill
 *   window) else create one; the game starts 5s after creation. Joiners
 *   after start (late joiners) get a SOLO triviaGameStart including
 *   `currentQuestionIndex` so they drop in mid-quiz. Room
 *   `trivia-ffa-${gameId}`.
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
 * ELO: 1v1 → eloService.settle1v1 (K=32; score tie = draw S=0.5);
 * FFA → eloService.settleFfa (K=16, placement by final score, correct
 * answers stand in for kills per handoff §6).
 */

import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import {
  generateQuestions,
  type GeneratedQuestion,
} from '../../services/questionGenerator'
import {
  settle1v1,
  settleFfa,
  type FfaStanding,
  type FfaRatingResult,
  type Settle1v1Result,
} from '../../services/eloService'

// ---------------------------------------------------------------------------
// Tunables (design contract "Trivia" section)
// ---------------------------------------------------------------------------
const QUESTION_MS = 15_000 // answer window per question
const ROUND_MS = 17_000 // 15s answer + 2s reveal → advance cadence
const COUNTDOWN_MS = 3_000 // client-side 3s countdown after triviaGameStart
const FFA_FILL_MS = 5_000 // open-lobby fill window before an FFA game starts
const FFA_MAX_PLAYERS = 100
const QUESTION_COUNT = 10
const GAME_KEY = 'trivia' // eloHistory.gameKey for both modes

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
interface QueueEntry {
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
  startTimer: ReturnType<typeof setTimeout> | null // FFA 5s fill window
  countdownTimer: ReturnType<typeof setTimeout> | null // 3s client countdown
  revealTimer: ReturnType<typeof setTimeout> | null // per-question 15s reveal
  loopTimer: ReturnType<typeof setInterval> | null // 17s advance loop
}

// What `newRatings` looks like on the wire: 1v1 keeps eloService's shape;
// FFA entries are wallet-STRIPPED FfaRatingResults; null = unrated game.
type NewRatings =
  | Settle1v1Result
  | Omit<FfaRatingResult, 'wallet'>[]
  | null

const waiting1v1: QueueEntry[] = [] // FIFO — shift() to pair
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
    const questions = await generateQuestions({
      topic,
      count: QUESTION_COUNT,
      difficulty: 'mixed',
    })
    if (questions.length > 0) return { topic, questions }
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
  if (game.mode === '1v1' && game.players.length === 2) {
    const [a, b] = game.players
    const scoreA = game.scores[a.name] ?? 0
    const scoreB = game.scores[b.name] ?? 0
    // Score tie → draw (S=0.5 for both, per contract — never skipped).
    const result = scoreA === scoreB ? 'draw' : scoreA > scoreB ? 'a' : 'b'
    newRatings = await settle1v1(GAME_KEY, a.wallet, b.wallet, result)
  } else if (game.mode === 'ffa') {
    // Only still-connected players get rated (leavers forfeit — we no
    // longer hold a live seat for them, but their score stays in results).
    const standings: FfaStanding[] = game.players.map((p) => ({
      wallet: p.wallet,
      score: game.scores[p.name] ?? 0,
      kills: p.correctCount, // correct answers substitute kills (handoff §6)
    }))
    const settled = await settleFfa(GAME_KEY, standings)
    // Strip wallets before the room broadcast (global rule).
    newRatings = settled
      ? settled.map((r) => ({
          name: r.name,
          rating: r.rating,
          change: r.change,
          placement: r.placement,
        }))
      : null
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
    newRatings = await settle1v1(GAME_KEY, survivor.wallet, leaver.wallet, 'a')
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

/** Create a fresh FFA game: question generation kicks off IMMEDIATELY so
 *  the LLM latency overlaps the 5s fill window instead of adding to it. */
function createFfa(io: Server, entry: QueueEntry) {
  const game = makeGame('ffa')
  games.set(game.gameId, game)
  addFfaPlayer(game, entry)

  game.questionsPromise = loadQuestions() // never rejects (falls back)
  game.startTimer = setTimeout(async () => {
    const loaded = await game.questionsPromise!
    // Everyone may have bailed (or teardown ran) during generation.
    if (games.get(game.gameId) !== game || game.status !== 'lobby') return
    if (game.players.length === 0) {
      teardown(game)
      return
    }
    game.topic = loaded.topic
    game.questions = loaded.questions
    broadcastStart(io, game)
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
      }
      return
    }
  }

  // Open lobby (fill window still running) → join it. The 5s window is
  // enforced by the startTimer flipping status to 'active', so checking
  // status is exactly the "≤ 5s old" rule (stretched only while the
  // question fallback is still resolving — joining then is harmless).
  for (const game of games.values()) {
    if (
      game.mode === 'ffa' &&
      game.status === 'lobby' &&
      game.players.length < FFA_MAX_PLAYERS
    ) {
      addFfaPlayer(game, entry)
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

// ---------------------------------------------------------------------------
// registerTrivia — wires this socket's trivia events + its own disconnect
// ---------------------------------------------------------------------------
export function registerTrivia(io: Server, socket: Socket) {
  // findTriviaGame { profile?, config: { mode: '1v1'|'ffa' } }
  socket.on('findTriviaGame', (raw) => {
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
    }

    if (parsed.data.config.mode === '1v1') {
      // One queue slot per wallet — re-emitting replaces the old entry.
      removeQueueWhere((e) => e.wallet === wallet)

      // FIFO: shift() the oldest LIVE entry (skip stale disconnected ones
      // defensively — disconnect cleanup should already have pruned them).
      let opponent: QueueEntry | undefined
      while (waiting1v1.length > 0) {
        const head = waiting1v1.shift()
        if (!head) break
        if (head.socket.connected && head.wallet !== wallet) {
          opponent = head
          break
        }
      }

      if (opponent) {
        void start1v1(io, opponent, entry) // first-queued listed first
      } else {
        waiting1v1.push(entry)
        socket.emit('waiting', 'Waiting for opponent...')
      }
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
