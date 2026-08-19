/**
 * usePracticeXp — the practice-mode twin of the online match:progression flow
 * ===========================================================================
 * Online games get their "+XP / level" overlay from the server's
 * `match:progression` socket event. Practice (vs-AI) rounds never touch the
 * socket layer, so this hook closes the gap the other way round:
 *
 *   reportRound(...) → POST /api/stats/session (the same metered,
 *   self-reported path the iframe games use — XP only, never RP, practice
 *   rows excluded from win rate) → the XpAward comes back → it is dressed in
 *   the MatchProgression shape → the game's existing <PostGameProgression>
 *   plays the identical circle-loader / LEVEL UP sequence.
 *
 * EXACTLY-ONCE per round, StrictMode-proof twice over: the hook keeps a
 * per-round ref guard (armRound() resets it when a new round starts), and
 * lib/sessionXp.ts keeps its own page-lifetime dedupe on the same key.
 * Reporting is fire-and-forget — a failed write shows nothing rather than
 * an error, exactly like the iframe games.
 */
import { useCallback, useRef, useState } from 'react'
import type { SessionReport } from '../lib/api'
import { reportGameSession } from '../lib/sessionXp'
import type { MatchProgression } from './useGameSocket'

export function usePracticeXp(gameKey: SessionReport['gameKey']): {
  /** Feed alongside the socket progression: `progression ?? practiceProgression`. */
  practiceProgression: MatchProgression | null
  /** Call when a round STARTS (or resets) — re-arms the once-per-round guard. */
  armRound: () => void
  /** Call once when a practice round ends. Duplicate calls are no-ops. */
  reportRound: (
    outcome: Pick<SessionReport, 'result' | 'score' | 'durationMs'>
  ) => void
  clearPracticeProgression: () => void
} {
  const [practiceProgression, setPracticeProgression] =
    useState<MatchProgression | null>(null)
  // Fresh id per round: doubles as the sessionXp dedupe key, so even a
  // re-fire that slips past the local guard cannot double-report.
  const roundIdRef = useRef<string>(crypto.randomUUID())
  const reportedRef = useRef(false)

  const armRound = useCallback(() => {
    roundIdRef.current = crypto.randomUUID()
    reportedRef.current = false
  }, [])

  const reportRound = useCallback(
    (outcome: Pick<SessionReport, 'result' | 'score' | 'durationMs'>) => {
      if (reportedRef.current) return
      reportedRef.current = true
      void reportGameSession(
        { gameKey, mode: 'practice', ...outcome },
        `${gameKey}:practice:${roundIdRef.current}`
      ).then((award) => {
        // MatchProgressionXp is a structural subset of the server XpAward,
        // so the award slots straight in; rank is null — practice never
        // touches RP, so there is nothing to rank up.
        if (award && award.amount > 0) {
          setPracticeProgression({ gameKey, xp: award, rank: null })
        }
      })
    },
    [gameKey]
  )

  const clearPracticeProgression = useCallback(
    () => setPracticeProgression(null),
    []
  )

  return { practiceProgression, armRound, reportRound, clearPracticeProgression }
}
