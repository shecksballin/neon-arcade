// src/components/common/GameChunkLoading.tsx
//
// The Suspense fallback for a lazily-loaded game (see App.tsx).
//
// It exists because every game is now behind `React.lazy`, so opening one has a
// download step the arcade never used to have. That step is the WHOLE POINT —
// it is what keeps the nine games out of the landing page's bundle — but it
// must never look like a broken screen, so this fills the viewport in the
// arcade's own colours and names the game it is fetching.
import { Loader2 } from 'lucide-react';

interface GameChunkLoadingProps {
  /** Game name, shown to the player (e.g. "Neon Chess"). */
  label: string;
}

export function GameChunkLoading({ label }: GameChunkLoadingProps) {
  return (
    <div className="w-full h-full min-h-screen bg-[#081616] flex flex-col items-center justify-center gap-5">
      <Loader2 className="w-9 h-9 text-[#00FFD1] animate-spin" />
      <p className="text-[10px] font-mono tracking-[0.35em] uppercase text-[#00FFD1]/70">
        Loading {label}
      </p>
    </div>
  );
}

export default GameChunkLoading;
