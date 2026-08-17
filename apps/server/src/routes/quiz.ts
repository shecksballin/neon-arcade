/**
 * QUIZ ROUTES (Hono)
 * ===================
 * The ONLY place the client can request AI-generated questions.
 * The OpenRouter key never leaves the server — the browser only
 * ever talks to this route.
 *
 * Two response shapes:
 * - withAnswers: false (default) → strips correctAnswer before sending.
 *   Used for live/wager play so a player can't read answers from
 *   the network tab. Answers are checked server-side.
 * - withAnswers: true → only for solo practice where cheating
 *   yourself is pointless. Still your call whether to allow it.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { generateQuestions } from '../services/questionGenerator'

const quiz = new Hono()

// Validate the incoming request body
const GenerateRequestSchema = z.object({
  topic:      z.string().min(2).max(60),
  count:      z.number().int().min(1).max(15).default(5),
  difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']).default('mixed'),
  // Solo practice can receive the correct answers (cheating yourself is
  // pointless). Live/wager play leaves this false so answers stay server-side.
  withAnswers: z.boolean().default(false),
})

// In-memory store of answers per generated set, keyed by a session id.
// For production, put this in Redis with a TTL instead.
const answerStore = new Map<string, number[]>()

quiz.post('/generate', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = GenerateRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400)
  }

  const { topic, count, difficulty, withAnswers } = parsed.data

  try {
    const questions = await generateQuestions({ topic, count, difficulty })

    // Generate a set id and stash the correct answers server-side
    const setId = crypto.randomUUID()
    answerStore.set(setId, questions.map(q => q.correctAnswer))

    // Map to the client shape. correctAnswer is included only for solo
    // practice (withAnswers); otherwise it stays server-side and the
    // client must verify via POST /check.
    const clientQuestions = questions.map((q, i) => ({
      index:      i,
      question:   q.question,
      options:    q.options,
      category:   q.category,
      difficulty: q.difficulty,
      ...(withAnswers ? { correctAnswer: q.correctAnswer } : {}),
    }))

    return c.json({ setId, questions: clientQuestions })
  } catch (err: any) {
    // Don't leak internals — generic message to client, log the detail
    console.error('Question generation failed:', err.message)
    return c.json({ error: 'Could not generate questions, try again' }, 502)
  }
})

// Check an answer server-side — the client never had the correct index
quiz.post('/check', async (c) => {
  const body = await c.req.json().catch(() => null)
  const schema = z.object({
    setId:         z.string().uuid(),
    questionIndex: z.number().int().min(0),
    answerIndex:   z.number().int().min(0).max(3),
  })
  const parsed = schema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const { setId, questionIndex, answerIndex } = parsed.data
  const answers = answerStore.get(setId)
  if (!answers) return c.json({ error: 'Question set expired' }, 404)

  const correctIndex = answers[questionIndex]
  const isCorrect = answerIndex === correctIndex

  return c.json({ correct: isCorrect, correctIndex })
})

export default quiz
