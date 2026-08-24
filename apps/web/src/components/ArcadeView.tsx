/**
 * ARCADE VIEW — the game library
 * ==============================
 * Lives in its own file, and is React.lazy'd from App.tsx, for a bundle
 * reason as much as a tidiness one. This view is the only thing on the
 * landing path that touches:
 *
 *   LibraryBlob      → glass/Ferrofluid → ogl        (WebGL fluid background)
 *   MagicGameTile    → gsap                          (tile tilt + particles)
 *
 * While it was inlined in App.tsx those were static imports of the entry
 * chunk, so every visitor downloaded and parsed a WebGL renderer and an
 * animation engine to look at a page that renders neither. Both libraries are
 * also used by the game lobbies, which are already lazy — so splitting here
 * lets Rollup put them in a chunk shared by the library and the lobbies, and
 * the landing page pays for none of it.
 *
 * THE GRID ITSELF is driven entirely by lib/games.ts: which tiles exist, what
 * the filter pills are, and which games a phone is allowed to see all come
 * from that catalog rather than from JSX written out nine times.
 */

import React from "react";
import { motion, AnimatePresence } from "motion/react";
import { Settings } from "lucide-react";

import { LibraryBlob } from "./glass/LibraryBlob";
import { MagicBentoGameTile, GlobalSpotlight } from "./glass/MagicGameTile";
import { GAME_ICONS } from "./glass/gameIcons";
import {
  GAMES,
  GAME_FILTERS,
  visibleGames,
  type GameId,
  type GameCategory,
} from "../lib/games";
import { useDevice } from "../hooks/useIsMobile";

export default function ArcadeView({
  onSelectGame,
  masterVolume,
  onVolumeChange,
  showVolumeConfig,
  onToggleVolumeConfig,
}: {
  /** One handler for every tile — the tile's own GameId says which. */
  onSelectGame: (id: GameId) => void;
  masterVolume: number;
  onVolumeChange: (vol: number) => void;
  showVolumeConfig: boolean;
  onToggleVolumeConfig: () => void;
}) {
  const gridRef = React.useRef<HTMLDivElement>(null);
  // isTouch, not isNarrow: a narrow desktop window still has a keyboard, so
  // resizing one must not make the PC-only titles disappear.
  const { isTouch, isNarrow } = useDevice();

  // null === "All Games". Kept as the category itself rather than an index so
  // the strip can be reordered without touching this.
  const [filter, setFilter] = React.useState<GameCategory | null>(null);

  const games = React.useMemo(
    () => visibleGames({ isMobile: isTouch, filter }),
    [isTouch, filter],
  );

  // On a touch device every remaining tile is mobile-compatible by
  // construction, so a "Mobile" pill there would be a no-op filter.
  const filters = React.useMemo(
    () => (isTouch ? GAME_FILTERS.filter((f) => f.id !== "mobile") : GAME_FILTERS),
    [isTouch],
  );

  return (
    /*
      `justify-start` at EVERY breakpoint, on purpose. Desktop used to
      `md:justify-center`, which re-centred the whole main block every time a
      filter changed the grid's row count — the filter strip visibly jumped
      up and down as you clicked pills. Anchoring to the top keeps the strip
      and the first tile row at one fixed position for every filter (and on
      phones centring was never an option: centring overflowing content in a
      scroll container pushes its top above the scrollable area).
    */
    <div className="relative h-full w-full flex flex-col items-center justify-start overflow-y-auto overflow-x-hidden pt-24 md:pt-28 pb-24">
      {/* Dark Background. The WebGL blob is decoration only — on a phone it
          costs battery and GPU for something behind a full-page gradient, so
          the plain background stands in. */}
      <div className="fixed inset-0 z-0 bg-[#081616]">
        {!isNarrow && <LibraryBlob />}
        <div className="absolute inset-0 bg-gradient-to-t from-[#081616] via-transparent to-[#081616]/50"></div>
      </div>

      {/* Cursor-tracking glow across the grid — nothing to track without a
          pointer, and it listens on mousemove app-wide, so skip it on touch. */}
      {!isTouch && <GlobalSpotlight gridRef={gridRef} />}

      <main className="relative z-10 w-full max-w-7xl px-4 sm:px-6 md:px-8 flex flex-col items-center">
        {/*
          FILTER STRIP. Horizontally scrollable rather than wrapping, so a
          phone gets one tidy swipeable row instead of three ragged lines that
          push the grid below the fold. `-mx-4 px-4` lets the row bleed to the
          screen edges while its first/last pills stay clear of them, which is
          what makes it read as scrollable.
        */}
        <div
          role="tablist"
          aria-label="Filter games by category"
          className="w-full mb-5 md:mb-7 flex gap-2 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap sm:justify-center"
        >
          {filters.map((f) => {
            const active = filter === f.id;
            return (
              <button
                key={f.label}
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(f.id)}
                className={`shrink-0 px-4 py-2 min-h-[44px] rounded-full border text-[11px] md:text-xs font-black uppercase tracking-[0.15em] transition-all active:scale-95 cursor-pointer select-none ${
                  active
                    ? "border-[#00FFD1] text-[#00382c] bg-[#00FFD1] shadow-[0_0_20px_rgba(0,255,209,0.45)]"
                    : "border-[#00FFD1]/30 text-white/70 hover:text-white hover:border-[#00FFD1]/70 backdrop-blur-md"
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <div
          ref={gridRef}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6 w-full bento-section"
        >
          {games.map((g) => (
            <MagicBentoGameTile
              key={g.id}
              onClick={() => onSelectGame(g.id)}
              icon={GAME_ICONS[g.id]}
              title={g.title}
            />
          ))}
        </div>

        {/*
          A filter can legitimately empty the grid — "Board Games" on a phone
          leaves Connect and Chess, but "Quiz" leaves nothing, since Neon Quiz
          is desktop-only. Say so instead of showing a blank page.
        */}
        {games.length === 0 && (
          <p className="text-white/50 text-xs uppercase tracking-[0.2em] text-center py-16 px-6">
            No games in this category
            {isTouch ? " are available on mobile yet" : ""}.
          </p>
        )}

        {/*
          Phones only ever see the three touch-ready titles, and a library
          that silently drops six games looks broken rather than curated.
        */}
        {isTouch && !filter && games.length > 0 && (
          <p className="text-white/40 text-[10px] uppercase tracking-[0.2em] text-center mt-8 px-6 leading-relaxed">
            {GAMES.length - games.length} more titles need a keyboard or mouse —
            play them on desktop.
          </p>
        )}
      </main>

      {/* Floating Settings Button in the bottom right of the library.
          Sits above the iOS home indicator via the safe-area inset. */}
      <div className="fixed bottom-6 right-6 md:bottom-8 md:right-8 z-[50] pb-[env(safe-area-inset-bottom)]">
        <button
          onClick={onToggleVolumeConfig}
          className="p-4 rounded-full border border-[#00FFD1]/40 hover:scale-105 active:scale-95 transition-all flex items-center justify-center cursor-pointer select-none backdrop-blur-md bg-[#081616]/70"
          title="Configure Master Volume"
          aria-label="Configure master volume"
        >
          <Settings className="w-6 h-6 animate-spin-slow text-white" />
        </button>

        <AnimatePresence>
          {showVolumeConfig && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 10 }}
              className="absolute bottom-20 right-0 w-64 max-w-[calc(100vw-3rem)] bg-black/95 border border-[#00FFD1]/40 rounded-2xl p-6 shadow-2xl backdrop-blur-xl z-[60] space-y-4 text-left font-mono"
            >
              <h4 className="text-white font-black uppercase text-xs tracking-wider">
                System Options
              </h4>
              <div className="space-y-2">
                <div className="flex justify-between text-[10px] uppercase text-white/50">
                  <span>Master Volume</span>
                  <span>{Math.round(masterVolume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={masterVolume}
                  onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                  className="w-full accent-[#00FFD1] bg-[#111E1E] rounded-lg appearance-none h-1 cursor-pointer"
                  aria-label="Master volume"
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
