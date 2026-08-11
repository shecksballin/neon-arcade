import React, { useState, Suspense } from 'react';
import ClumsyLobby from './ClumsyLobby';
import { Loader2 } from 'lucide-react';
import GameBackButton from '../common/GameBackButton';

// Lazy-loaded so the heavy three.js + Rapier game bundle is only fetched when
// the player starts a match, keeping the arcade's initial load fast.
const ClumsyPlay = React.lazy(() => import('./ClumsyPlay'));

interface ClumsyGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inGame: boolean) => void;
}

function ClumsyLoading() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#0d0824] text-white">
      <Loader2 className="w-10 h-10 text-[#00FFD1] animate-spin" />
      <p className="font-black tracking-[0.3em] uppercase text-sm text-[#00FFD1]">
        Loading Neon Clumsy…
      </p>
    </div>
  );
}

const ClumsyGame = ({ onExit, profile, onGameStatusChange }: ClumsyGameProps) => {
  const [gameState, setGameState] = useState<'lobby' | 'playing'>('lobby');

  React.useEffect(() => {
    onGameStatusChange?.(gameState !== 'lobby');
  }, [gameState, onGameStatusChange]);

  const handleStartGame = () => {
    setGameState('playing');
  };

  if (gameState === 'playing') {
    return (
      <div className="relative w-full h-full bg-[#0d0824]">
        <Suspense fallback={<ClumsyLoading />}>
          <ClumsyPlay onExit={() => setGameState('lobby')} />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative">
      <GameBackButton onClick={onExit} title="Back to arcade" positionClassName="absolute top-6 left-6 z-50" />
      <ClumsyLobby
        onFindGame={handleStartGame}
        onPlayComputer={handleStartGame}
        onExit={onExit}
      />
    </div>
  );
};

export default ClumsyGame;
