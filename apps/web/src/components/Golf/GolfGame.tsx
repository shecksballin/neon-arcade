import React, { useState } from 'react';
import GolfLobby from './GolfLobby';
import NeonGolfClash from './NeonGolfClash';
import GameBackButton from '../common/GameBackButton';

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
      <GameBackButton onClick={onExit} title="Back to arcade" positionClassName="absolute top-6 left-6 z-50" />
      <GolfLobby
        onFindGame={handleStartGame}
        onPlayComputer={handleStartGame}
        onExit={onExit}
      />
    </div>
  );
};

export default GolfGame;
