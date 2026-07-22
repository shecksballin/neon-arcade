import React, { useState } from 'react';
import ClumsyLobby from './ClumsyLobby';
import { ChevronLeft } from 'lucide-react';

interface ClumsyGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inGame: boolean) => void;
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
      <div className="relative w-full h-full bg-[#081616] flex items-center justify-center text-white">
        <div className="absolute top-24 left-6 z-30 pointer-events-none">
          <button
            onClick={() => setGameState('lobby')}
            className="p-3 bg-black/50 border border-[#00FFD1]/30 hover:border-[#00FFD1] hover:bg-[#00FFD1]/20 rounded-full text-white backdrop-blur-md transition-all cursor-pointer pointer-events-auto"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        </div>
        <div className="text-center">
          <h2 className="text-4xl font-black text-[#00FFD1] tracking-widest uppercase italic mb-4">
            Game Under Construction
          </h2>
          <p className="text-white/60 font-mono text-sm tracking-wider">
            Neon Clumsy gameplay will be available soon.
          </p>
        </div>
      </div>
    );
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
      <ClumsyLobby
        onFindGame={handleStartGame}
        onPlayComputer={handleStartGame}
        onExit={onExit}
      />
    </div>
  );
};

export default ClumsyGame;
