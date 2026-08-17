import { useEffect, useState } from 'react';
import { motion } from 'motion/react';

/**
 * Shared "SEARCHING FOR ONLINE MATCH" screen.
 *
 * Every online/lobby game (Chess, Volley, Connect, Quiz, Cells slayer/lms,
 * Asteroids slayer/lms, Golf, Clumsy, Pug Shooter) renders THIS component
 * while queued so the matchmaking experience is identical everywhere. The
 * copy is fixed on purpose — do not reword the headline per game.
 *
 * Purely presentational: it owns no socket, no queue state and no timers other
 * than the cosmetic "elapsed" readout. The parent decides when to mount it
 * (optimistically, on click — never waiting for a server ack), keeps
 * `playersInQueue` fresh from `queue:status`, and does the actual
 * leave-the-queue work inside `onCancel`.
 *
 * Visual language is lifted from the existing neon screens (ChessGame's
 * "Searching Arena..." block and TriviaGame's "Scanning Neural Grid" block):
 * Space Grotesk black italic headline with the .neon-text-glow utility,
 * #00FFD1 accents, #B1C5FF secondary text, mono uppercase wide tracking.
 */
export interface SearchingForMatchProps {
  /** Live count of players currently queued for this mode (incl. this client). */
  playersInQueue?: number;
  /**
   * How many players the mode needs before the match starts. Drives the
   * `PLAYERS: n / N` readout — omit it entirely on 1v1 modes (Chess, Volley,
   * Connect, Quiz 1v1) to hide the counter, pass it on roster modes
   * (Quiz FFA, Cells/Asteroids slayer + lms, Golf, Clumsy, Pug Shooter).
   */
  playersNeeded?: number;
  /** Leave the queue and go back to the lobby. Always wired to the CANCEL button. */
  onCancel: () => void;
  /** Optional replacement for the default line under the headline. */
  subtitle?: string;
  /** Escape hatch for the outer wrapper (sizing/positioning in odd layouts). */
  className?: string;
}

/** Primary neon accent, matching the rest of the arcade. */
const ACCENT = '#00FFD1';

export function SearchingForMatch({
  playersInQueue,
  playersNeeded,
  onCancel,
  subtitle = 'Waiting for real opponents to join the grid',
  className = '',
}: SearchingForMatchProps) {
  // Cosmetic only — reassures the player that the screen is alive while the
  // queue fills. Not used for any timeout logic; the parent owns that.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, '0');

  // Only 1v1 modes omit `playersNeeded`; anything that needs a roster passes it.
  const showCount = typeof playersNeeded === 'number' && playersNeeded > 0;
  // We are queued the moment this screen mounts, so "at least me" is the floor.
  const current = Math.max(1, playersInQueue ?? 1);
  const needed = playersNeeded ?? 0;
  const filled = showCount ? Math.min(current, needed) : 0;
  // Below ~10 slots individual pips read nicely; above that use a solid bar.
  const usePips = showCount && needed <= 10;

  return (
    <div
      className={`w-full h-full min-h-[420px] flex flex-col items-center justify-center px-6 py-10 text-center select-none ${className}`}
    >
      {/* ── Radar spinner ─────────────────────────────────────────────
          Outer sweep + counter-rotating inner sweep + pulsing core +
          an expanding "ping" ring. All motion/react so it stays in step
          with the transitions the rest of the app uses. */}
      <div className="relative w-36 h-36 flex items-center justify-center mb-9">
        <motion.div
          className="absolute inset-0 rounded-full border-4 border-[#00FFD1]/15 border-t-[#00FFD1] shadow-[0_0_28px_rgba(0,255,209,0.35)]"
          animate={{ rotate: 360 }}
          transition={{ duration: 1.6, ease: 'linear', repeat: Infinity }}
        />
        <motion.div
          className="absolute inset-[18px] rounded-full border-2 border-[#B1C5FF]/10 border-b-[#B1C5FF]/60"
          animate={{ rotate: -360 }}
          transition={{ duration: 2.8, ease: 'linear', repeat: Infinity }}
        />
        <motion.div
          className="absolute inset-0 rounded-full border border-[#00FFD1]/50"
          animate={{ scale: [0.45, 1.18], opacity: [0.75, 0] }}
          transition={{ duration: 2.2, ease: 'easeOut', repeat: Infinity }}
        />
        <motion.div
          className="w-4 h-4 rounded-full bg-[#00FFD1] shadow-[0_0_18px_#00FFD1]"
          animate={{ scale: [1, 1.55, 1], opacity: [0.55, 1, 0.55] }}
          transition={{ duration: 1.4, ease: 'easeInOut', repeat: Infinity }}
        />
      </div>

      {/* ── Headline — fixed copy across every game ────────────────── */}
      <h1 className="text-3xl sm:text-4xl font-black text-[#FFFFFD] neon-text-glow uppercase italic tracking-tighter">
        Searching for online match
      </h1>

      {/* Chess's bouncing triad, kept for visual continuity. */}
      <div className="flex justify-center gap-3 mt-6">
        {[0, 0.2, 0.4].map((delay) => (
          <span
            key={delay}
            className="w-2.5 h-2.5 rounded-full bg-[#00FFD1] animate-bounce shadow-[0_0_10px_#00ffd1]"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
      </div>

      {/* ── Live roster count (multi-player modes only) ────────────── */}
      {showCount && (
        <div className="mt-8 flex flex-col items-center gap-3">
          <span
            className="font-mono text-sm tracking-[0.35em] uppercase font-bold"
            style={{ color: ACCENT, textShadow: '0 0 12px rgba(0,255,209,0.6)' }}
          >
            Players: {filled} / {needed}
          </span>

          {usePips ? (
            <div className="flex items-center gap-2">
              {Array.from({ length: needed }).map((_, i) => (
                <motion.span
                  key={i}
                  className="h-2.5 w-6 rounded-full"
                  animate={{
                    backgroundColor:
                      i < filled ? ACCENT : 'rgba(0,255,209,0.12)',
                    boxShadow:
                      i < filled
                        ? '0 0 12px rgba(0,255,209,0.75)'
                        : '0 0 0 rgba(0,0,0,0)',
                  }}
                  transition={{ duration: 0.25 }}
                />
              ))}
            </div>
          ) : (
            <div className="h-2.5 w-56 rounded-full bg-[#00FFD1]/12 overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-[#00FFD1] shadow-[0_0_12px_rgba(0,255,209,0.75)]"
                animate={{ width: `${needed ? (filled / needed) * 100 : 0}%` }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Status line + elapsed ──────────────────────────────────── */}
      <p className="mt-8 text-[#B1C5FF] font-mono text-[11px] tracking-[0.28em] uppercase opacity-60">
        {subtitle}
      </p>
      <p className="mt-2 font-mono text-[10px] tracking-[0.3em] uppercase text-white/25">
        Elapsed {mm}:{ss}
      </p>

      {/* ── Cancel — leaves the queue, returns to the lobby ────────── */}
      <button
        type="button"
        onClick={onCancel}
        className="mt-10 px-10 py-3 rounded-xl border border-[#00FFD1] text-[#00FFD1] font-mono text-xs uppercase tracking-[0.28em] hover:bg-[#00FFD1]/10 hover:shadow-[0_0_18px_rgba(0,255,209,0.35)] transition-all"
      >
        Cancel
      </button>
    </div>
  );
}

export default SearchingForMatch;
