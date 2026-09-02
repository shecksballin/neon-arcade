/**
 * FULL-SCREEN MAP SELECTION — the page the lobby's map tile navigates to.
 *
 * The MorphSlider owns the whole stage here (the lobby only shows the
 * chosen map as a small preview tile). Selection is a DRAFT until
 * CONFIRMED: browsing the slider never touches the lobby's map state, so
 * the back chevron is a true cancel — you return with whatever map you
 * arrived with. Esc = back, same as every popup in this lobby.
 *
 * Rendered as a fixed overlay above the lobby (which stays mounted, so
 * mode/difficulty/options state survives the round-trip). It deliberately
 * covers the parent's "Back to arcade" chevron — on this page, back means
 * back to the LOBBY.
 */
import { useEffect, useState } from 'react'
import { ChevronLeft, Check } from 'lucide-react'
import MorphSlider from './MorphSlider'
import { MAPS, MAP_SLIDES, type PugShooterMap } from './pugShooterMaps'

export default function PugShooterMapSelect({
  initialMap,
  onConfirm,
  onBack,
}: {
  /** The lobby's current map — where the slider starts. */
  initialMap: PugShooterMap
  /** Commit the draft and return to the lobby. */
  onConfirm: (map: PugShooterMap) => void
  /** Discard the draft and return to the lobby. */
  onBack: () => void
}) {
  // The draft: what the slider is showing, committed only by CONFIRM.
  const [draftIndex, setDraftIndex] = useState(() =>
    Math.max(0, MAPS.findIndex((m) => m.id === initialMap))
  )
  const draft = MAPS[draftIndex]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack()
      // Enter confirms — but not while a BUTTON has focus (the back chevron
      // or an arrow), where Enter already clicks that button and firing both
      // would confirm a map the player was backing away from.
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        onConfirm(draft.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, onConfirm, draft.id])

  return (
    <div className="fixed inset-0 z-[95] bg-[#081616] flex flex-col items-center p-6 overflow-y-auto">
      {/* Background highlights, matching the lobby's look */}
      <div className="absolute inset-0 opacity-20 pointer-events-none">
        <div className="absolute top-20 left-20 w-96 h-96 bg-[#00FFD1] rounded-full blur-[120px] opacity-20 animate-pulse"></div>
        <div
          className="absolute bottom-20 right-20 w-96 h-96 bg-[#FF0080] rounded-full blur-[120px] opacity-20 animate-pulse"
          style={{ animationDelay: '1s' }}
        ></div>
      </div>

      {/* Back to the lobby (cancel — the draft is discarded) */}
      <button
        onClick={onBack}
        title="Back to lobby"
        className="absolute top-6 left-6 z-20 p-3 bg-black/50 border border-[#00FFD1]/30 hover:border-[#00FFD1] hover:bg-[#00FFD1]/20 rounded-full text-white backdrop-blur-md transition-all cursor-pointer"
      >
        <ChevronLeft className="w-6 h-6" />
      </button>

      <div className="relative z-10 flex flex-col items-center gap-6 w-full max-w-5xl my-auto py-10">
        <div className="text-center space-y-2">
          <h1 className="text-4xl md:text-6xl font-black text-[#FFFFFD] drop-shadow-[0_0_20px_rgba(0,255,209,0.6)] uppercase tracking-tighter italic">
            Select Map
          </h1>
          <p className="text-[10px] font-mono tracking-[0.3em] uppercase text-[#B1C5FF]/50">
            swipe · drag · arrow keys
          </p>
        </div>

        {/* The stage — MorphSlider fills its container absolutely. */}
        <div className="relative w-full h-[48vh] min-h-[280px] sm:h-[55vh]">
          <MorphSlider
            items={MAP_SLIDES}
            startIndex={draftIndex}
            onIndexChange={setDraftIndex}
            transition="melt"
            intensity={0.55}
            aberration={0.35}
            drift={0.4}
            overlayColor="#00FFD1"
            radius={20}
            duration={0.9}
            showCaptions
            showControls
            showIndicators
          />
        </div>

        <div className="text-center space-y-1">
          <p className="text-[10px] font-mono tracking-[0.25em] uppercase text-[#B1C5FF]/60">
            {draft.detail}
          </p>
          <p className="text-[9px] font-mono tracking-[0.25em] uppercase text-[#B1C5FF]/35">
            free-for-all holds up to {draft.ffaCap} players
          </p>
        </div>

        <button
          onClick={() => onConfirm(draft.id)}
          className="inline-flex items-center gap-3 px-10 py-4 bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] rounded-2xl font-black text-lg uppercase tracking-tighter italic shadow-[0_0_40px_rgba(0,255,209,0.35)] hover:scale-[1.03] active:scale-[0.97] transition-all cursor-pointer"
        >
          <Check className="w-5 h-5" />
          Confirm {draft.label}
        </button>
      </div>
    </div>
  )
}
