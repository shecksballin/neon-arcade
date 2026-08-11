import React, { useState } from 'react';
import KillerLobby from './KillerLobby';
import GameBackButton from '../common/GameBackButton';

interface KillerGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inGame: boolean) => void;
}

const KillerGame = ({ onExit, profile, onGameStatusChange }: KillerGameProps) => {
  const [gameState, setGameState] = useState<'lobby' | 'playing'>('lobby');

  React.useEffect(() => {
    onGameStatusChange?.(gameState !== 'lobby');
  }, [gameState, onGameStatusChange]);

  const handleStartGame = () => {
    setGameState('playing');
  };

  if (gameState === 'playing') {
    return (
      <div className="relative w-full h-full bg-[#081616] flex items-center justify-center text-white">
        <GameBackButton onClick={() => setGameState('lobby')} positionClassName="absolute top-24 left-6 z-30" />
        <div className="text-center">
          <h2 className="text-4xl font-black text-[#00FFD1] tracking-widest uppercase italic mb-4">
            Game Under Construction
          </h2>
          <p className="text-white/60 font-mono text-sm tracking-wider">
            Neon Killer gameplay will be available soon.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative">
      <GameBackButton onClick={onExit} title="Back to arcade" positionClassName="absolute top-6 left-6 z-50" />
      <KillerLobby
        onFindGame={handleStartGame}
        onPlayComputer={handleStartGame}
        onExit={onExit}
      />
    </div>
  );
};

export default KillerGame;
