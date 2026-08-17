/**
 * QUIZ API — frontend helper
 * ===========================
 * The browser calls YOUR backend here. It never touches
 * OpenRouter and never sees the API key — that stays server-side.
 *
 * Import this in TriviaCore / TriviaGame instead of calling
 * any AI SDK from the client.
 */

import { ApiError, NETWORK_ERROR_MESSAGE } from '../../lib/api'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3002'

export interface ClientQuestion {
  index:          number
  question:       string
  options:        string[]
  category:       string
  difficulty:     'easy' | 'medium' | 'hard'
  // Present only when the set was requested withAnswers: true (solo practice).
  // For live/wager play it's omitted and answers are checked via checkAnswer().
  correctAnswer?: number
}

export interface GeneratedSet {
  setId:     string
  questions: ClientQuestion[]
}

// Ask the backend to generate a fresh set of questions on a topic.
// Pass withAnswers: true for solo practice so the client can score locally.
export async function generateQuestions(
  topic: string,
  count = 5,
  difficulty: 'easy' | 'medium' | 'hard' | 'mixed' = 'mixed',
  withAnswers = false
): Promise<GeneratedSet> {
  let res: Response
  try {
    res = await fetch(`${API_URL}/api/quiz/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, count, difficulty, withAnswers }),
    })
  } catch (err) {
    console.error(`[quiz] network failure (${API_URL}):`, err)
    throw new ApiError(0, NETWORK_ERROR_MESSAGE)
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new ApiError(res.status, err.error ?? 'Could not generate questions')
  }

  return res.json()
}

// Check an answer server-side (client never had the correct index)
export async function checkAnswer(
  setId: string,
  questionIndex: number,
  answerIndex: number
): Promise<{ correct: boolean; correctIndex: number }> {
  let res: Response
  try {
    res = await fetch(`${API_URL}/api/quiz/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setId, questionIndex, answerIndex }),
    })
  } catch (err) {
    console.error(`[quiz] network failure (${API_URL}):`, err)
    throw new ApiError(0, NETWORK_ERROR_MESSAGE)
  }

  if (!res.ok) throw new ApiError(res.status, 'Answer check failed')
  return res.json()
}
