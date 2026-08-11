import React, { useState, Suspense } from 'react';
import PugShooterLobby, { PugShooterMatchConfig } from './PugShooterLobby';
import { Loader2 } from 'lucide-react';
import GameBackButton from '../common/GameBackButton';

// Lazy-loaded so the iframe host (and with it the whole three.js + Rapier game
// behind it) is only fetched when the player starts a match, keeping the
// arcade's initial load fast.
const PugShooterPlay = React.lazy(() => import('./PugShooterPlay'));

interface PugShooterGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inGame: boolean) => void;
}

function PugShooterLoading() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#050d1c] text-white">
      <Loader2 className="w-10 h-10 text-[#00FFD1] animate-spin" />
      <p className="font-black tracking-[0.3em] uppercase text-sm text-[#00FFD1]">
        Loading Neon Pug Shooter…
      </p>
    </div>
  );
}

const PugShooterGame = ({ onExit, profile, onGameStatusChange }: PugShooterGameProps) => {
  const [match, setMatch] = useState<PugShooterMatchConfig | null>(null);

  React.useEffect(() => {
    onGameStatusChange?.(match !== null);
  }, [match, onGameStatusChange]);

  if (match) {
    return (
      <div className="relative w-full h-full bg-[#050d1c]">
        <Suspense fallback={<PugShooterLoading />}>
          <PugShooterPlay config={match} onExit={() => setMatch(null)} />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative">
      <GameBackButton onClick={onExit} title="Back to arcade" positionClassName="absolute top-6 left-6 z-50" />
      <PugShooterLobby
        onFindGame={setMatch}
        onPlayComputer={setMatch}
        onExit={onExit}
      />
    </div>
  );
};

export default PugShooterGame;
