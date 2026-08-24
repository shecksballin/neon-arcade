/**
 * CursorGlow.tsx
 *
 * A #00FFD1 radial glow blob that follows the user's cursor.
 * Sits between the asset background (z-index 0) and the glass
 * panels (bump GlassPanel's z-index to 2 after adding this).
 *
 * Layer order after adding this:
 *   z-index 0 → LiquidBackground  (image / 3D canvas)
 *   z-index 1 → CursorGlow        (this component) ← new
 *   z-index 2 → GlassPanel        (backdrop-filter panels)
 *
 * The glow bleeds through the glass panel's backdrop-filter blur,
 * tinting the frost with the #00FFD1 colour as the cursor moves.
 *
 * Performance:
 *   - Zero React re-renders. Position updates go directly to the DOM
 *     via a ref and requestAnimationFrame.
 *   - The lerp (linear interpolation) creates a smooth organic lag.
 *     Tune LERP_FACTOR: higher = snappier (0.08–0.25 is a good range).
 *   - willChange: 'transform' hints the browser to GPU-composite the layer.
 */

import { useEffect, useRef } from 'react'

/* ── Config ─────────────────────────────────────────────────────────────── */

const GLOW_COLOR   = '#00FFEA'
const GLOW_SIZE    = 800          // diameter in px
const LERP_FACTOR  = 0.10        // 0.0 = frozen, 1.0 = instant snap
const BLUR_SPREAD  = 80          // px — controls soft edge of the blob
const OUTER_OPACITY = 0.65       // overall opacity (0–1)

/* ── Component ──────────────────────────────────────────────────────────── */

export function CursorGlow() {
  const blobRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    /* Current render position (starts off-screen) */
    let rx = -9999
    let ry = -9999

    /* Target position (raw mouse coords) */
    let tx = -9999
    let ty = -9999

    let rafId: number

    function onMouseMove(e: MouseEvent) {
      tx = e.clientX
      ty = e.clientY
    }

    /**
     * On touch devices, follow the first touch point.
     * The glow still renders; it just snaps to last-touched position.
     */
    function onTouchMove(e: TouchEvent) {
      const t = e.touches[0]
      if (!t) return
      tx = t.clientX
      ty = t.clientY
    }

    /**
     * SLEEPING LOOP. The old tick re-queued itself unconditionally, so the
     * glow kept writing sub-pixel transforms (the lerp asymptotes, it never
     * lands) and invalidating its layer 60x/s with the pointer parked —
     * forever. Now the loop cancels itself once it is within a pixel of the
     * target and the pointer handlers wake it back up; a parked cursor costs
     * zero frames.
     */
    let sleeping = false
    function wake() {
      if (!sleeping) return
      sleeping = false
      rafId = requestAnimationFrame(tick)
    }

    function tick() {
      /* Lerp render position toward target */
      rx += (tx - rx) * LERP_FACTOR
      ry += (ty - ry) * LERP_FACTOR

      const settled = Math.abs(tx - rx) < 0.5 && Math.abs(ty - ry) < 0.5
      if (settled) {
        rx = tx
        ry = ty
        sleeping = true
      } else {
        rafId = requestAnimationFrame(tick)
      }

      /* Write directly to DOM — no React setState, no re-render */
      if (blobRef.current) {
        blobRef.current.style.transform =
          `translate(${rx - GLOW_SIZE / 2}px, ${ry - GLOW_SIZE / 2}px)`
      }
    }

    const onMouseMoveWake = (e: MouseEvent) => { onMouseMove(e); wake() }
    const onTouchMoveWake = (e: TouchEvent) => { onTouchMove(e); wake() }
    window.addEventListener('mousemove', onMouseMoveWake, { passive: true })
    window.addEventListener('touchmove', onTouchMoveWake, { passive: true })
    rafId = requestAnimationFrame(tick)

    return () => {
      window.removeEventListener('mousemove', onMouseMoveWake)
      window.removeEventListener('touchmove', onTouchMoveWake)
      cancelAnimationFrame(rafId)
    }
  }, [])

  return (
    <div
      aria-hidden="true"
      style={{
        /* Position the containing layer to fill the hero section */
        position: 'absolute',
        inset: 0,
        zIndex: 1,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <div
        ref={blobRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: GLOW_SIZE,
          height: GLOW_SIZE,
          borderRadius: '50%',

          /**
           * Radial gradient: hot #00FFD1 core fading to transparent.
           * Three stops give a natural "glow falloff" rather than a
           * hard disc edge.
           */
          background: [
            `radial-gradient(circle at 50% 50%,`,
            `  ${GLOW_COLOR}cc 0%,`,     /* inner core — more opaque  */
            `  ${GLOW_COLOR}66 40%,`,    /* mid glow                  */
            `  transparent 70%`,         /* soft outer edge           */
            `)`,
          ].join(''),

          /**
           * Gaussian blur beyond the gradient edge for the "light bleed"
           * feel. Pair with a large GLOW_SIZE so blur doesn't clip.
           */
          filter: `blur(${BLUR_SPREAD}px)`,

          opacity: OUTER_OPACITY,

          /**
           * Promote to its own compositor layer.
           * Prevents the blob from triggering repaints on the layers below.
           */
          willChange: 'transform',
        }}
      />
    </div>
  )
}
