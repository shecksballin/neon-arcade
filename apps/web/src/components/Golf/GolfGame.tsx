import React, { useState } from 'react';
import GolfLobby from './GolfLobby';
import NeonGolfClash from './NeonGolfClash';
import { ChevronLeft } from 'lucide-react';

interface GolfGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inGame: boolean) => void;
}

const GolfGame = ({ onExit, profile, onGameStatusChange }: GolfGameProps) => {
  const [gameState, setGameState] = useState<'lobby' | 'playing'>('lobby');

  React.useEffect(() => {
    onGameStatusChange?.(gameState !== 'lobby');
  }, [gameState, onGameStatusChange]);

  const handleStartGame = () => {
    setGameState('playing');
  };

  // Only mounted once the player picks a mode, so the game document is loaded
  // strictly on demand (see NeonGolfClash's iframe loader).
  if (gameState === 'playing') {
    return <NeonGolfClash onExit={() => setGameState('lobby')} />;
  }

  return (
    <div className="w-full h-full relative">
      <div className="absolute top-6 left-6 z-50">
        <button
          onClick={onExit}
          className="p-2 bg-black/40 border border-[#00FFD1]/30 hover:bg-[#00FFD1]/20 rounded-full text-white transition-all cursor-pointer"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
      </div>
      <GolfLobby
        onFindGame={handleStartGame}
        onPlayComputer={handleStartGame}
        onExit={onExit}
      />
    </div>
  );
};

export default GolfGame;
