/**
 * GAME TILE ICONS
 * ===============
 * Split out of App.tsx's library grid when that grid stopped being nine
 * hard-coded tiles and became a `.map()` over the catalog in lib/games.ts.
 * The catalog stays JSX-free (the sidebar and the mobile gate import it for
 * its data alone); the artwork lives here, keyed by the same GameId.
 *
 * These are the originals, moved verbatim — same Lucide icons, same inline
 * SVGs, same sizes. Only Neon Connect's four-dot grid and Volley's ball are
 * bespoke; the rest are single Lucide glyphs.
 */

import { Swords, Orbit, Rocket, Goal, FlagTriangleRight, Ghost, Crosshair } from "lucide-react";
import type { GameId } from "../../lib/games";

export const GAME_ICONS: Record<GameId, React.ReactNode> = {
  neonconnect: (
    <div className="grid grid-cols-2 gap-2">
      <div className="w-4 h-4 rounded-full bg-[#00FFD1] shadow-[0_0_10px_#00FFD1]" />
      <div className="w-4 h-4 rounded-full border border-[#00FFD1]/40" />
      <div className="w-4 h-4 rounded-full border border-[#00FFD1]/40" />
      <div className="w-4 h-4 rounded-full bg-[#00FFD1] shadow-[0_0_10px_#00FFD1]" />
    </div>
  ),
  chess: <Swords className="w-12 h-12" />,
  volley: (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="19" width="16" height="2" rx="1" />
      <circle cx="12" cy="11" r="3" />
      <path d="M10 9 C 7 5, 5 2, 4 0 C 8 3, 10 6, 11 9 Z" opacity="0.7" />
      <path d="M14 9 C 17 5, 19 2, 20 0 C 16 3, 14 6, 13 9 Z" opacity="0.7" />
      <path d="M12 8 C 12 4, 12 1, 12 -1 C 13 1, 13 4, 12 8 Z" opacity="0.5" />
    </svg>
  ),
  cells: <Orbit className="w-12 h-12" />,
  asteroids: <Rocket className="w-12 h-12 text-[#00FFD1] -rotate-45" />,
  kickoff: <Goal className="w-12 h-12 text-[#00FFD1]" />,
  golf: <FlagTriangleRight className="w-12 h-12 text-[#00FFD1]" />,
  clumsy: <Ghost className="w-12 h-12 text-[#00FFD1]" />,
  pugshooter: <Crosshair className="w-12 h-12 text-[#00FFD1]" />,
};
