/**
 * FULLSCREEN — one toggle, one button, one keybind for the whole arcade
 * =====================================================================
 * Before this file, fullscreen was five private implementations: Asteroids
 * and Cells fullscreened their own container, Trivia and Volley fullscreened
 * the document, each bound its own window-level 'f' listener, and none of
 * them guarded typing — TriviaLobby's own ENTER TOPIC input toggled
 * fullscreen on every 'f' typed into it.
 *
 * Now: everything targets the DOCUMENT (uniform result — in-game the nav is
 * hidden anyway, so "the game fullscreen" and "the app fullscreen" look the
 * same), the ONE 'f' listener lives in App via useGlobalFullscreenKey (so it
 * also works on the main menu), and it ignores keystrokes aimed at inputs,
 * textareas, selects and contenteditables.
 *
 * Iframe caveat, by design: while an iframe game (Clumsy/Pug/Golf) holds
 * focus, parent-window key events never fire — the visible FullscreenButton
 * is the affordance there.
 */
import { useEffect, useState } from 'react'
import { Maximize, Minimize } from 'lucide-react'
import { useMediaQuery } from 'react-responsive'

/** Toggle app fullscreen. Safe to call from anywhere; failures are quiet
 *  (browsers reject without a user gesture — nothing a player can act on). */
export function toggleAppFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {})
  } else {
    void document.documentElement.requestFullscreen().catch(() => {})
  }
}

/** Live "are we fullscreen" flag (document-wide, any element). */
export function useIsFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(() =>
    Boolean(document.fullscreenElement)
  )
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  return isFullscreen
}

/** True when this keyboard event is aimed at something the user types into —
 *  the guard every previous 'f' listener lacked. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  )
}

/**
 * THE 'f' keybind. Mount exactly ONCE (App.tsx) — every per-screen listener
 * was removed when this landed, so a second mount would reintroduce the
 * double-toggle those caused.
 */
export function useGlobalFullscreenKey(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'f' || e.repeat) return
      // Browser/OS chords (⌘F find, ctrl+F, alt layouts) are not ours.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      toggleAppFullscreen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

/**
 * The shared round glass fullscreen button (same shell as GameBackButton).
 * Swaps its icon with the live state; title advertises the keybind.
 */
export function FullscreenButton({
  positionClassName,
}: {
  /** When set, wraps the button in an absolutely-positioned container. */
  positionClassName?: string
}) {
  const isFullscreen = useIsFullscreen()
  // Phones get no fullscreen affordance at all (per design): iOS Safari
  // doesn't honour the API for arbitrary elements, and the OS chrome owns
  // that gesture on Android anyway.
  const isCoarse = useMediaQuery({ query: '(pointer: coarse) and (hover: none)' })
  if (isCoarse) return null

  const button = (
    <button
      onClick={toggleAppFullscreen}
      title={isFullscreen ? 'Exit Fullscreen (F)' : 'Fullscreen (F)'}
      className="p-3 bg-black/50 border border-[#00FFD1]/30 hover:border-[#00FFD1] hover:bg-[#00FFD1]/20 rounded-full text-white backdrop-blur-md transition-all cursor-pointer"
    >
      {/* The 4-L-corner glyphs — same icon the Neon Asteroids HUD uses. */}
      {isFullscreen ? <Minimize className="w-6 h-6" /> : <Maximize className="w-6 h-6" />}
    </button>
  )

  if (!positionClassName) return button
  return <div className={positionClassName}>{button}</div>
}
