import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';

// The standalone game lives in `public/Golf/` so Vite serves it VERBATIM. (A
// `.html` under `src/` gets run through Vite's HTML transform — rewriting its
// module scripts / importmap — which breaks this self-contained game.) It is
// referenced by URL, not imported, so nothing about the 3.3MB document is
// fetched until the <iframe> below mounts.
const GAME_SRC = `${import.meta.env.BASE_URL}Golf/NeonGolfClash.html`;

interface NeonGolfClashProps {
  onExit: () => void;
}

/**
 * Iframe loader for the self-contained Neon Golf Clash game.
 *
 * This component (and therefore the <iframe>) is only rendered once the player
 * chooses to play, so the large game document is loaded strictly on demand —
 * never preloaded while the user is still in the lobby.
 */
const NeonGolfClash = ({ onExit }: NeonGolfClashProps) => {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="relative w-full h-full bg-[#081616]">
      {/* Loading overlay shown until the game document finishes loading */}
      {!loaded && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#081616]">
          <div className="w-16 h-16 border-4 border-[#00FFD1]/20 border-t-[#00FFD1] rounded-full animate-spin mb-6" />
          <p className="text-[#00FFD1] font-mono text-xs uppercase tracking-[0.3em] animate-pulse">
            Loading Neon Golf Clash…
          </p>
        </div>
      )}

      {/* Back to lobby */}
      <div className="absolute top-6 left-6 z-30">
        <button
          onClick={onExit}
          className="p-2.5 bg-black/50 border border-[#00FFD1]/30 hover:border-[#00FFD1] hover:bg-[#00FFD1]/20 rounded-full text-white backdrop-blur-md transition-all cursor-pointer"
          title="Back to lobby"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
      </div>

      <iframe
        src={GAME_SRC}
        title="Neon Golf Clash"
        className="w-full h-full border-0 block"
        onLoad={() => setLoaded(true)}
        allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope"
      />
    </div>
  );
};

export default NeonGolfClash;
