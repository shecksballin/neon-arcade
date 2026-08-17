/**
 * QUESTION GENERATION SERVICE
 * ============================
 * Server-only. Calls Kimi K3 through OpenRouter to generate
 * trivia questions on demand for a given topic/difficulty.
 *
 * Two jobs for Zod here:
 * 1. config/env.ts already validated the API key (secret in)
 * 2. THIS file validates the model's JSON output (untrusted AI out)
 *    — LLMs occasionally return malformed shapes, so we never
 *      trust the response without parsing it.
 */

import { OpenRouter } from '@openrouter/sdk'
import { z } from 'zod'
import { config } from '../config/env'

// The SDK reads the key we pass — sourced from Doppler via config.
// httpReferer / appTitle are the optional OpenRouter ranking headers.
const openrouter = new OpenRouter({
  apiKey: config.OPENROUTER_API_KEY,
  ...(config.OPENROUTER_SITE_URL  ? { httpReferer: config.OPENROUTER_SITE_URL }  : {}),
  ...(config.OPENROUTER_SITE_NAME ? { appTitle:    config.OPENROUTER_SITE_NAME } : {}),
})

// Other FREE models (different providers) used as automatic fallbacks when the
// primary (config.QUIZ_MODEL) is rate-limited/unavailable. OpenRouter's `models`
// array tries them in order and skips ones that 429/error, so a saturated free
// tier on one provider doesn't fail the request. All are $0 on OpenRouter.
// OpenRouter caps the `models` array at 3 total, so keep this to 2 fallbacks
// (different providers than the primary Poolside model).
const FREE_FALLBACK_MODELS = [
  'openai/gpt-oss-20b:free',
  'google/gemma-4-31b-it:free',
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Which failures are worth retrying: upstream rate limits (429), provider 5xx,
// and the SDK's *response* validator tripping on an occasional odd model shape
// (content:null etc.). NOT transient — fail fast: 402 (no credits), 401 (bad
// key), 400 / "Input validation" (our own request bug).
function isTransient(err: any): boolean {
  const status = err?.statusCode
  const msg = String(err?.message ?? '')
  return (
    status === 429 ||
    (typeof status === 'number' && status >= 500) ||
    /response validation failed/i.test(msg)
  )
}

// ─────────────────────────────────────────────────
// Shape we expect back from the model.
// correctAnswer is the index (0-3) into options.
// ─────────────────────────────────────────────────
const GeneratedQuestionSchema = z.object({
  question:      z.string().min(5),
  options:       z.array(z.string().min(1)).length(4),
  correctAnswer: z.number().int().min(0).max(3),
  category:      z.string(),
  difficulty:    z.enum(['easy', 'medium', 'hard']),
})

export type GeneratedQuestion = z.infer<typeof GeneratedQuestionSchema>

// Pull the first JSON object out of a model response — handles code fences and
// surrounding prose that weaker/reasoning models sometimes add.
function extractJson(content: string): any {
  const cleaned = content.replace(/```json|```/g, '').trim()
  const tryParse = (s: string) => { try { return JSON.parse(s) } catch { return undefined } }
  let obj = tryParse(cleaned)
  if (obj === undefined) {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start !== -1 && end > start) obj = tryParse(cleaned.slice(start, end + 1))
  }
  return obj
}

// Normalize one raw question, tolerating common free-model variations
// (difficulty casing, correctAnswer as a letter/string/answer-text, missing
// category). Returns null if it can't be salvaged into a valid 4-option item.
function normalizeQuestion(raw: any, topic: string): GeneratedQuestion | null {
  if (!raw || typeof raw !== 'object') return null

  const question = typeof raw.question === 'string' ? raw.question.trim() : ''
  const options = Array.isArray(raw.options)
    ? raw.options.map((o: any) => String(o).trim()).filter((o: string) => o.length > 0)
    : []
  if (question.length < 5 || options.length !== 4) return null

  // correctAnswer: index number, numeric string, letter A–D, or the answer text.
  let ca: any = raw.correctAnswer
  if (typeof ca === 'string') {
    const t = ca.trim()
    if (/^[0-3]$/.test(t)) ca = Number(t)
    else if (/^[A-Da-d]$/.test(t)) ca = t.toUpperCase().charCodeAt(0) - 65
    else ca = options.findIndex((o: string) => o.toLowerCase() === t.toLowerCase())
  }
  if (typeof ca !== 'number' || !Number.isInteger(ca) || ca < 0 || ca > 3) return null

  let diff = typeof raw.difficulty === 'string' ? raw.difficulty.trim().toLowerCase() : ''
  if (diff !== 'easy' && diff !== 'medium' && diff !== 'hard') diff = 'medium'

  const category = typeof raw.category === 'string' && raw.category.trim()
    ? raw.category.trim()
    : topic

  return { question, options, correctAnswer: ca, category, difficulty: diff as GeneratedQuestion['difficulty'] }
}

// Salvage as many valid questions as possible from a model response.
function parseQuestions(content: string, topic: string): GeneratedQuestion[] {
  const obj = extractJson(content)
  const arr = Array.isArray(obj?.questions) ? obj.questions
    : Array.isArray(obj) ? obj
    : []
  return arr.map((q: any) => normalizeQuestion(q, topic)).filter(Boolean) as GeneratedQuestion[]
}

// ─────────────────────────────────────────────────
// GENERATE QUESTIONS
// Returns fully-formed questions INCLUDING correct answers.
// The caller (route) decides what to strip before sending
// to the client.
// ─────────────────────────────────────────────────
export async function generateQuestions({
  topic,
  count = 5,
  difficulty = 'mixed',
}: {
  topic: string
  count?: number
  difficulty?: 'easy' | 'medium' | 'hard' | 'mixed'
}): Promise<GeneratedQuestion[]> {

  // The key is optional at boot (env.ts) so the server can start without it.
  // If it's genuinely absent, fail with a clear message instead of a confusing
  // 401 from OpenRouter. NOTE: when running via `turbo`, this var must be
  // listed in turbo.json's globalPassThroughEnv or strict mode strips it even
  // though Doppler injected it into the parent process.
  if (!config.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is not set — add it to Doppler and ensure it is in turbo.json globalPassThroughEnv',
    )
  }

  const difficultyLine = difficulty === 'mixed'
    ? 'Mix easy, medium, and hard difficulties.'
    : `All questions should be ${difficulty} difficulty.`

  const systemPrompt = [
    'You are a trivia question generator.',
    'Return ONLY valid JSON — no markdown, no code fences, no commentary.',
    'Schema: { "questions": [ { "question": string, "options": [string, string, string, string], "correctAnswer": number (0-3 index of the correct option), "category": string, "difficulty": "easy"|"medium"|"hard" } ] }',
    'Exactly 4 options per question. Exactly one correct.',
    'Make plausible wrong answers — no obvious throwaways.',
    'Do not repeat questions.',
  ].join(' ')

  const userPrompt = `Generate ${count} trivia questions about "${topic}". ${difficultyLine}`

  // Non-streaming call — we need the whole JSON before parsing.
  // NOTE: the SDK wraps the completion body under `chatRequest`. Passing the
  // fields at the top level throws an SDKValidationError before any network
  // request is ever made.
  //
  // We intentionally do NOT send response_format here: the default model
  // (poolside/laguna-s-2.1:free) does not advertise response_format support,
  // and forcing it can be rejected. We rely on the strict system prompt plus
  // the tolerant extraction below instead, which keeps this model-agnostic.
  // Primary model first, then free fallbacks. OpenRouter routes to the first
  // available one and falls through the list on rate-limit/error.
  const models = [config.QUIZ_MODEL, ...FREE_FALLBACK_MODELS]
    .filter((m, i, arr) => arr.indexOf(m) === i)
    .slice(0, 3) // OpenRouter allows at most 3 models in the fallback array

  // One bounded retry loop over "call + parse". Each attempt lets OpenRouter try
  // every model in `models`; we retry on transient send failures OR when the
  // response can't be parsed into valid questions (a re-request may route to a
  // cleaner model). Non-transient send errors (no credits / bad key) fail fast.
  const MAX_ATTEMPTS = 3
  let lastError: unknown = new Error('Could not generate questions')
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await openrouter.chat.send({
        chatRequest: {
          models,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
          ],
        },
      })

      // Non-streaming send() resolves to a ChatResult ({ choices: [...] }).
      const raw = 'choices' in response ? response.choices?.[0]?.message?.content : undefined
      if (typeof raw === 'string' && raw.length > 0) {
        const questions = parseQuestions(raw, topic)
        if (questions.length > 0) return questions.slice(0, count)
      }
      lastError = new Error('Model output could not be parsed into valid questions')
    } catch (err) {
      lastError = err
      if (!isTransient(err)) throw err // no credits / bad key / our bug → stop
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleep(600 * (attempt + 1))
  }

  throw lastError
}
