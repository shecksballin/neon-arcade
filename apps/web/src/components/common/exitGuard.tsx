/**
 * EXIT GUARD — "are you sure? leaving forfeits" for every game
 * ============================================================
 * Every exit affordance in the arcade — the App nav bar's Main Menu /
 * Library buttons, each game's pause-menu "Quit", the Chess/Connect side
 * panel's EXIT GAME and mode-switch cards — funnels its navigation through
 * `navigateWithExitGuard(continuation)`. While a forfeitable round is live,
 * the mounted game registers ONE intercept via `useGuardedExit`; with no
 * intercept registered the continuation just runs, exactly as before.
 *
 * The intercepted flow (the whole point of this file):
 *
 *   click → "Are you sure?" dialog → confirm → the game's `onForfeit` flips
 *   it into its ended-as-a-loss state (emit resign / report the loss) → the
 *   game's OWN results screen shows the defeat → PostGameProgression plays
 *   the XP/rank overlays (rank only in ranked modes; practice pays XP only,
 *   by construction of usePracticeXp) → the game calls `finishExit()` from
 *   the progression's onDone → the ORIGINAL navigation finally runs.
 *
 * Safety nets, because the happy path leans on a server round-trip:
 *   • PROGRESSION_TIMEOUT_MS — if no progression ever lands (offline,
 *     signed-out practice, zero-XP instant forfeit), navigation runs anyway.
 *   • MIN_RESULTS_DWELL_MS — however fast progression resolves, the results
 *     screen gets a beat on screen before navigation.
 *   • A second exit click while the post-forfeit flow is playing runs the
 *     NEW continuation immediately — the player is telling us to hurry up.
 *
 * One guard at a time by design: exactly one game screen is mounted (App's
 * `view` ternary), and each game owns one `useGuardedExit`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'

type ExitIntercept = (proceed: () => void) => void

let activeIntercept: ExitIntercept | null = null

/**
 * Run `navigate` now — unless a live game has registered a guard, in which
 * case the guard owns it (confirm → forfeit → results → progression → then
 * `navigate`). Every exit/navigation path that can fire mid-game calls this.
 */
export function navigateWithExitGuard(navigate: () => void): void {
  if (activeIntercept) activeIntercept(navigate)
  else navigate()
}

function registerExitIntercept(intercept: ExitIntercept): () => void {
  activeIntercept = intercept
  return () => {
    if (activeIntercept === intercept) activeIntercept = null
  }
}

/** Guarantee the results screen a beat on screen before navigating away. */
const MIN_RESULTS_DWELL_MS = 2200
/** Give up waiting for progression after this and navigate anyway. */
const PROGRESSION_TIMEOUT_MS = 12000

export interface ExitGuardCopy {
  title?: string
  message: string
  confirmLabel?: string
  stayLabel?: string
}

/** The shared "Are you sure?" overlay — GamePauseMenu's frosted look, one
 *  step above it (z-[130] > pause 125) so it always wins the argument. */
export function ExitConfirmDialog({
  title = 'Leave the match?',
  message,
  confirmLabel = 'Leave & forfeit',
  stayLabel = 'Keep playing',
  onConfirm,
  onStay,
}: {
  title?: string
  message: string
  confirmLabel?: string
  stayLabel?: string
  onConfirm: () => void
  onStay: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[130] flex flex-col items-center justify-center gap-[18px] px-6 text-center"
      style={{ background: 'rgba(3,10,18,0.86)', backdropFilter: 'blur(10px)' }}
    >
      <h1 className="text-[34px] md:text-[40px] font-black italic uppercase tracking-[-0.5px] text-[#e8f6f4]">
        {title}
      </h1>
      <p className="max-w-md font-mono text-[11px] uppercase tracking-[0.22em] leading-relaxed text-white/60">
        {message}
      </p>

      {/* Primary — stay. Leaving is the destructive act, so it never gets
          the solid teal pill. */}
      <button
        onClick={onStay}
        className="rounded-full px-9 py-3 font-black italic uppercase tracking-[0.06em] text-[13px] cursor-pointer transition-[filter] hover:brightness-110"
        style={{ background: '#00FFD1', color: '#04211c', boxShadow: '0 0 30px rgba(0,255,209,0.35)' }}
      >
        {stayLabel}
      </button>

      <button
        onClick={onConfirm}
        className="rounded-full px-9 py-3 font-black italic uppercase tracking-[0.06em] text-[13px] cursor-pointer text-red-300 transition-colors hover:bg-red-500/20"
        style={{ background: 'rgba(255,60,60,0.08)', border: '1px solid rgba(255,90,90,0.35)' }}
      >
        {confirmLabel}
      </button>
    </div>
  )
}

/**
 * The per-game half of the guard. Mount ONE per game screen.
 *
 * `active`    — a forfeitable round is live right now (playing, not ended,
 *               not merely queue-searching: cancelling a queue is not a loss).
 * `onForfeit` — flip the game into its ended-as-a-loss state: emit the
 *               resign/leave socket event, or set local ended state + report
 *               the practice loss. Return 'wait' to hold navigation for the
 *               results + progression flow (then call `finishExit()` from
 *               the progression's onDone), or 'immediate' when there is
 *               nothing to show (local co-op, drop-in free play).
 * `copy`      — dialog wording; a function is resolved at click time so it
 *               can read the current mode.
 */
export function useGuardedExit({
  active,
  onForfeit,
  copy,
}: {
  active: boolean
  onForfeit: () => 'wait' | 'immediate'
  copy: ExitGuardCopy | (() => ExitGuardCopy)
}): {
  /** Route an exit affordance through the guard: runs `continuation` now
   *  when nothing is at stake, else opens the confirm dialog. */
  requestExit: (continuation: () => void) => void
  /** Call when the post-forfeit results/progression flow has finished. */
  finishExit: () => void
  /** The player changed their mind after forfeiting (clicked Rematch on the
   *  results screen): drop the deferred navigation without running it. */
  abortPendingExit: () => void
  /** True between confirm and the deferred navigation running. */
  exitPending: boolean
  /**
   * True while the "are you sure?" dialog is on screen. Games that swallow
   * keys during play (Volley holds Tab for its scoreboard) need this to stop
   * doing so while a modal wants the keyboard — a dialog whose buttons
   * cannot be reached by Tab is a keyboard trap.
   */
  confirmOpen: boolean
  /** Render this once, anywhere in the game's tree. */
  confirmDialog: React.ReactNode
} {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [exitPending, setExitPending] = useState(false)
  const [dialogCopy, setDialogCopy] = useState<ExitGuardCopy | null>(null)

  const activeRef = useRef(active)
  activeRef.current = active
  const onForfeitRef = useRef(onForfeit)
  onForfeitRef.current = onForfeit
  const copyRef = useRef(copy)
  copyRef.current = copy

  const pendingRef = useRef(false)
  const continuationRef = useRef<(() => void) | null>(null)
  const confirmedAtRef = useRef(0)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimers = useCallback(() => {
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
    if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current)
    fallbackTimerRef.current = null
    dwellTimerRef.current = null
  }, [])

  const runContinuation = useCallback(() => {
    clearTimers()
    pendingRef.current = false
    setExitPending(false)
    setConfirmOpen(false)
    const cont = continuationRef.current
    continuationRef.current = null
    cont?.()
  }, [clearTimers])

  const requestExit = useCallback(
    (continuation: () => void) => {
      if (pendingRef.current) {
        // The player found another way out while the post-forfeit flow was
        // playing (results Exit, another nav click) — honor the NEW intent
        // right now rather than making them watch the rest.
        continuationRef.current = continuation
        runContinuation()
        return
      }
      if (!activeRef.current) {
        continuation()
        return
      }
      // A dialog cannot be clicked through a captured pointer.
      document.exitPointerLock?.()
      continuationRef.current = continuation
      const c = copyRef.current
      setDialogCopy(typeof c === 'function' ? c() : c)
      setConfirmOpen(true)
    },
    [runContinuation]
  )

  const finishExit = useCallback(() => {
    if (!pendingRef.current) return
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
    fallbackTimerRef.current = null
    const elapsed = Date.now() - confirmedAtRef.current
    const wait = Math.max(0, MIN_RESULTS_DWELL_MS - elapsed)
    if (wait === 0) runContinuation()
    else if (!dwellTimerRef.current) {
      dwellTimerRef.current = setTimeout(runContinuation, wait)
    }
  }, [runContinuation])

  const handleConfirm = useCallback(() => {
    setConfirmOpen(false)
    const flow = onForfeitRef.current()
    if (flow === 'immediate') {
      runContinuation()
      return
    }
    pendingRef.current = true
    setExitPending(true)
    confirmedAtRef.current = Date.now()
    fallbackTimerRef.current = setTimeout(runContinuation, PROGRESSION_TIMEOUT_MS)
  }, [runContinuation])

  const handleStay = useCallback(() => {
    setConfirmOpen(false)
    continuationRef.current = null
  }, [])

  const abortPendingExit = useCallback(() => {
    if (!pendingRef.current) return
    clearTimers()
    pendingRef.current = false
    setExitPending(false)
    continuationRef.current = null
  }, [clearTimers])

  // The game ended by itself while the dialog was up (opponent finished the
  // round) — the "leaving loses" premise is gone, so drop the question and
  // let the normal end-of-game flow tell the story.
  useEffect(() => {
    if (!active && confirmOpen && !pendingRef.current) {
      setConfirmOpen(false)
      continuationRef.current = null
    }
  }, [active, confirmOpen])

  // App-level nav (Main Menu / Library / logo) flows into requestExit while
  // a round is live — and stays captured while the post-forfeit flow plays,
  // so a second nav click "hurries up" instead of double-navigating.
  useEffect(() => {
    if (!active && !exitPending) return
    return registerExitIntercept(requestExit)
  }, [active, exitPending, requestExit])

  useEffect(() => clearTimers, [clearTimers])

  const confirmDialog =
    confirmOpen && dialogCopy ? (
      <ExitConfirmDialog
        title={dialogCopy.title}
        message={dialogCopy.message}
        confirmLabel={dialogCopy.confirmLabel}
        stayLabel={dialogCopy.stayLabel}
        onConfirm={handleConfirm}
        onStay={handleStay}
      />
    ) : null

  return {
    requestExit,
    finishExit,
    abortPendingExit,
    exitPending,
    confirmOpen,
    confirmDialog,
  }
}
