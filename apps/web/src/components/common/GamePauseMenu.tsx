/**
 * GAME PAUSE MENU — the Pug Shooter pause pattern, for every game
 * ===============================================================
 * Neon Pug Shooter's in-iframe pause UI is the arcade's reference: a small
 * glass "Menu" pill in the bottom-right HUD corner opening a full-screen
 * frosted overlay — big italic heading, a solid teal primary action, ghost
 * pills under it, "Quit to lobby" last. This is that exact look as a React
 * component, so every game shares one exit affordance instead of a floating
 * back chevron (removed by the same design pass; back buttons now live only
 * on library/lobby screens).
 *
 * Faithful to the reference (apps/web/public/neon-pug-shooter/index.html):
 *   trigger  — 10x22px pill, 12px 900-weight italic uppercase, black 40%
 *              glass, teal 20% border, blur(10px), bottom-right 32px
 *   overlay  — fixed inset-0, rgba(3,10,18,.82) + blur(10px), column,
 *              18px gap; h1 40px/900/italic/uppercase
 *   primary  — teal pill (#00FFD1 on #04211c, radius 999, teal glow)
 *   ghosts   — white 8% fill, white 15% border
 *
 * Semantics: opening this does NOT freeze a server-authoritative match —
 * online play continues underneath, exactly like every multiplayer pause
 * menu. The default title is therefore "Menu"; a single-player game that
 * genuinely halts (and says so via onOpenChange) may pass title="Paused".
 * z-[125] sits above game HUDs, the results screen (z-[100]) and the
 * progression overlays (z-[120]) — a player reaching for the exit must
 * always be able to see it.
 */
import React, { useEffect, useState } from 'react'
import { useMediaQuery } from 'react-responsive'
import { useIsFullscreen, toggleAppFullscreen } from './fullscreen'

/** True for targets whose keystrokes must never drive the menu. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  )
}

export function GamePauseMenu({
  onExit,
  title = 'Menu',
  exitLabel = 'Quit to lobby',
  onOpenChange,
  inline = false,
  children,
}: {
  /** The ONE way out of the game — wired to what the back button used to do. */
  onExit: () => void
  title?: string
  exitLabel?: string
  /** Single-player games may pause/resume their loop on this signal. */
  onOpenChange?: (open: boolean) => void
  /**
   * Render the trigger pill in normal flow (for games whose control bars
   * host it — Asteroids/Cells) instead of pinning it bottom-right.
   */
  inline?: boolean
  /** Optional extra ghost actions, rendered between Fullscreen and Quit. */
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const isFullscreen = useIsFullscreen()
  // Touch devices have no Escape key — they keep the visible pill. Desktop
  // stays pill-less (ESC only), per design.
  const isCoarse = useMediaQuery({ query: '(pointer: coarse) and (hover: none)' })

  const setOpenAnd = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }

  /**
   * ESC IS THE MENU. The visible "Menu" pill was removed by request — the
   * overlay now toggles on Escape, the same key every game's players already
   * reach for. Notes:
   *   - typing targets are ignored so a chat box can be escaped normally;
   *   - Escape also releases pointer lock / exits fullscreen natively first
   *     in some browsers — the second press lands here, which reads fine;
   *   - the iframe games (Golf/Clumsy/Pug) each have their OWN in-iframe ESC
   *     pause with a quit path, so a focused iframe swallowing this key does
   *     not strand anyone.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat) return
      if (isTypingTarget(e.target)) return
      setOpen((prev) => {
        const next = !prev
        onOpenChange?.(next)
        return next
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // onOpenChange is a stable-enough callee; re-binding per parent render
    // would race a held key. Read via closure on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      {isCoarse && !open && (
        <div
          className={inline ? 'z-[60]' : 'absolute bottom-8 right-8 z-[60]'}
          style={{ pointerEvents: 'auto' }}
        >
          <button
            onClick={() => setOpenAnd(true)}
            className="px-[22px] py-[10px] rounded-xl text-[12px] font-black italic uppercase tracking-[0.06em] text-white/75 bg-black/40 border border-[#00FFD1]/20 backdrop-blur-[10px] transition-colors hover:text-[#00FFD1] hover:border-[#00FFD1]/50 cursor-pointer"
          >
            Menu
          </button>
        </div>
      )}
      {open && (
        <div
          className="fixed inset-0 z-[125] flex flex-col items-center justify-center gap-[18px]"
          style={{ background: 'rgba(3,10,18,0.82)', backdropFilter: 'blur(10px)' }}
        >
          <h1 className="text-[40px] font-black italic uppercase tracking-[-0.5px] text-[#e8f6f4]">
            {title}
          </h1>

          {/* Primary — Resume, solid teal pill. */}
          <button
            onClick={() => setOpenAnd(false)}
            className="rounded-full px-9 py-3 font-black italic uppercase tracking-[0.06em] text-[13px] cursor-pointer transition-[filter] hover:brightness-110"
            style={{ background: '#00FFD1', color: '#04211c', boxShadow: '0 0 30px rgba(0,255,209,0.35)' }}
          >
            Resume
          </button>

          {/* Ghost — fullscreen, advertising the keybind. */}
          <button
            onClick={toggleAppFullscreen}
            className="rounded-full px-9 py-3 font-black italic uppercase tracking-[0.06em] text-[13px] text-[#e8f6f4] cursor-pointer transition-[filter] hover:brightness-110"
            style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)' }}
          >
            {isFullscreen ? 'Exit Fullscreen (F)' : 'Fullscreen (F)'}
          </button>

          {children}

          {/* Ghost — the exit. The only way out of the game, by design. */}
          <button
            onClick={() => {
              setOpenAnd(false)
              onExit()
            }}
            className="rounded-full px-9 py-3 font-black italic uppercase tracking-[0.06em] text-[13px] text-[#e8f6f4] cursor-pointer transition-[filter] hover:brightness-110"
            style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)' }}
          >
            {exitLabel}
          </button>
        </div>
      )}
    </>
  )
}
