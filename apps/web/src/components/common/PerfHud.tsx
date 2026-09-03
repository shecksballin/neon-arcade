/**
 * PERF HUD — the small "FPS · ping" readout every game screen shows.
 *
 * Placement contract: closest free spot to the TOP-RIGHT corner. A game whose
 * top-right is already owned by a leaderboard/HUD passes `positionClassName`
 * to sit immediately to that element's LEFT instead — never on top of it.
 *
 * FPS is measured HERE, in the parent document, on purpose: the iframe games
 * (Clumsy/Pug/Golf) are same-origin, so they share this renderer's main
 * thread — when the game inside janks, this rAF slows identically. One
 * implementation therefore reads true for every game shape (socket, iframe,
 * R3F) without threading a counter through each game loop.
 *
 * Ping prefers the shared authed socket (a `latency:ping` ack round-trip —
 * the same transport gameplay rides, so it reports what the player actually
 * feels). Signed out / disconnected it falls back to timing an HTTP fetch
 * against the server origin; with no server configured it shows "--".
 */
import { useEffect, useState } from 'react'
import { getSocket, SOCKET_URL } from '../../hooks/useGameSocket'

/** ms between ping samples — frequent enough to feel live, far too slow to load anything. */
const PING_INTERVAL_MS = 2500
/** ms per FPS window — two updates a second reads calm but current. */
const FPS_WINDOW_MS = 500

function pingColor(ms: number | null): string {
  if (ms === null) return 'text-white/40'
  if (ms <= 80) return 'text-[#00FFD1]'
  if (ms <= 160) return 'text-[#FFD166]'
  return 'text-[#FF6B9A]'
}

function fpsColor(fps: number | null): string {
  if (fps === null) return 'text-white/40'
  if (fps >= 50) return 'text-[#00FFD1]'
  if (fps >= 30) return 'text-[#FFD166]'
  return 'text-[#FF6B9A]'
}

export function PerfHud({
  positionClassName = 'absolute top-4 right-4 z-40',
}: {
  /** Override to dodge a game's own top-right UI (see the header). */
  positionClassName?: string
}) {
  const [fps, setFps] = useState<number | null>(null)
  const [ping, setPing] = useState<number | null>(null)

  // FPS: count rAF ticks per window. One setState per WINDOW, not per frame —
  // the readout must never itself become jank.
  useEffect(() => {
    let raf = 0
    let frames = 0
    let windowStart = performance.now()
    const tick = (now: number) => {
      frames += 1
      const elapsed = now - windowStart
      if (elapsed >= FPS_WINDOW_MS) {
        setFps(Math.round((frames * 1000) / elapsed))
        frames = 0
        windowStart = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Ping: socket ack round-trip when connected, HTTP timing otherwise.
  useEffect(() => {
    let disposed = false

    const sample = () => {
      const socket = getSocket()
      const started = performance.now()
      if (socket.connected) {
        // timeout() arms the ack: err fires instead if the server never answers.
        socket.timeout(PING_INTERVAL_MS * 2).emit('latency:ping', (err: unknown) => {
          if (disposed) return
          setPing(err ? null : Math.max(1, Math.round(performance.now() - started)))
        })
        return
      }
      if (!SOCKET_URL) {
        setPing(null)
        return
      }
      // no-cors: an opaque response still measures the round-trip, and a
      // signed-out player gets a number instead of a CORS console error.
      fetch(SOCKET_URL, { mode: 'no-cors', cache: 'no-store' })
        .then(() => {
          if (!disposed) setPing(Math.max(1, Math.round(performance.now() - started)))
        })
        .catch(() => {
          if (!disposed) setPing(null)
        })
    }

    sample()
    const interval = setInterval(sample, PING_INTERVAL_MS)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [])

  return (
    <div className={`${positionClassName} pointer-events-none select-none`}>
      {/* Mobile-first COMPACT: on phones the full-size pill collided with
          every game's top band (mobile play-test) — there it renders at
          8px type with tight padding; sm+ restores the desktop size. */}
      <div className="flex items-center gap-1.5 rounded-full border border-[#00FFD1]/25 bg-black/60 px-2 py-1 font-mono text-[8px] uppercase tracking-[0.15em] sm:gap-2 sm:px-3 sm:py-1.5 sm:text-[10px] sm:tracking-[0.2em]">
        <span className={fpsColor(fps)}>{fps === null ? '--' : fps} fps</span>
        <span className="text-white/25">·</span>
        <span className={pingColor(ping)}>{ping === null ? '--' : ping} ms</span>
      </div>
    </div>
  )
}
