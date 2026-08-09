import React from 'react';
import { ChevronLeft } from 'lucide-react';

interface ClumsyPlayProps {
  /** Return to the Clumsy lobby (unmounts the iframe, stopping the game). */
  onExit: () => void;
}

/**
 * Hosts the self-contained Neon Clumsy game (vanilla three.js + Rapier),
 * served statically from `public/neon-clumsy-game/`. Kept in an <iframe> so
 * the game runs in full isolation with its own importmap, HUD DOM, WASM
 * physics and render loop — and tears down cleanly when this unmounts.
 *
 * This module is loaded via React.lazy (see ClumsyGame), so the ~4MB three +
 * Rapier vendor bundle and the character glb only download when a player
 * actually starts a match — keeping the arcade's initial load fast.
 */
export default function ClumsyPlay({ onExit }: ClumsyPlayProps) {
  return (
    <div className="absolute inset-0 w-full h-full bg-[#0d0824]">
      <iframe
        src="/neon-clumsy-game/index.html"
        title="Neon Clumsy"
        className="block w-full h-full border-0"
        allow="pointer-lock; fullscreen; gamepad; autoplay; accelerometer; gyroscope"
      />
      {/* Back-to-lobby overlay (press Esc first if the pointer is locked). */}
      <div className="absolute top-24 left-6 z-30">
        <button
          onClick={onExit}
          title="Back to lobby"
          className="p-3 bg-black/50 border border-[#00FFD1]/30 hover:border-[#00FFD1] hover:bg-[#00FFD1]/20 rounded-full text-white backdrop-blur-md transition-all cursor-pointer"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
      </div>
    </div>
  );
}
