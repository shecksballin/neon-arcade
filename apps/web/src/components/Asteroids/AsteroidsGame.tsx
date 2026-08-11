// src/components/Asteroids/AsteroidsGame.tsx
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import AsteroidsLobby from './AsteroidsLobby';
import AsteroidsCore from './AsteroidsCore';
import { WagerModesMenu } from '../NeonBucks/WagerModesMenu';

interface AsteroidsGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inGame: boolean) => void;
}

const AsteroidsGame = ({ onExit, profile, onGameStatusChange }: AsteroidsGameProps) => {
  const [gameState, setGameState] = useState<'lobby' | 'wager' | 'playing'>('lobby');
  const [difficulty, setDifficulty] = useState(1);
  const [isMultiplayer, setIsMultiplayer] = useState(false);

  // Wager mode states
  const [wagerAmount, setWagerAmount] = useState(0);
  const [wagerMode, setWagerMode] = useState<'free_play' | 'slayer' | 'snake' | null>(null);
  const [targetKills, setTargetKills] = useState<number | undefined>(undefined);
  const [selectedLobbyMode, setSelectedLobbyMode] = useState<'free_play' | 'slayer' | 'snake' | null>(null);

  React.useEffect(() => {
    onGameStatusChange?.(gameState !== 'lobby');
  }, [gameState, onGameStatusChange]);

  const handlePlayComputer = (diff: number, mode: 'free_play' | 'slayer' | 'snake') => {
    setDifficulty(diff);
    setIsMultiplayer(false);
    setSelectedLobbyMode(mode);
    setGameState('wager');
  };

  const handleStartWager = (stake: number, mode: 'free_play' | 'slayer' | 'snake', tkills?: number) => {
    setWagerAmount(stake);
    setWagerMode(mode);
    setTargetKills(tkills);
    setGameState('playing');
  };

  const handleFindGame = (diff: number, mode: 'free_play' | 'slayer' | 'snake') => {
    setDifficulty(diff);
    setIsMultiplayer(true);
    setSelectedLobbyMode(mode);
    setGameState('wager');
  };

  return (
    <div className="h-full w-full bg-[#081616] relative flex justify-center">
      <AnimatePresence mode="wait">
        {(gameState === 'lobby' || gameState === 'wager') && (
          <motion.div
            key="lobby"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="w-full relative z-0"
          >
            <AsteroidsLobby 
                onFindGame={handleFindGame}
                onPlayComputer={handlePlayComputer}
                onExit={onExit}
            />
          </motion.div>
        )}
        {gameState === 'playing' && (
          <motion.div
            key="playing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full w-full absolute inset-0 z-10"
          >
            <AsteroidsCore 
              difficulty={difficulty}
              isMultiplayer={isMultiplayer}
              profile={profile}
              onExit={() => setGameState('lobby')}
              wagerAmount={wagerAmount}
              wagerMode={wagerMode}
              targetKills={targetKills}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {gameState === 'wager' && (
        <div className="absolute inset-0 z-50">
          <WagerModesMenu
            gameTitle="Neon Asteroids"
            onCancel={() => setGameState('lobby')}
            onStart={handleStartWager}
            fixedMode={selectedLobbyMode || undefined}
            isMultiplayer={isMultiplayer}
          />
        </div>
      )}
    </div>
  );
};

export default AsteroidsGame;
