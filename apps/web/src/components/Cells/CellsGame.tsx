// src/components/Cells/CellsGame.tsx
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import CellsLobby from './CellsLobby';
import ArgarGame from './ArgarGame';
import { WagerModesMenu } from '../NeonBucks/WagerModesMenu';

interface CellsGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
}

const CellsGame = ({ onExit, profile }: CellsGameProps) => {
  const [gameState, setGameState] = useState<'lobby' | 'wager' | 'playing'>('lobby');
  const [difficulty, setDifficulty] = useState(3);
  const [isMultiplayer, setIsMultiplayer] = useState(false);

  // Wager mode states
  const [wagerAmount, setWagerAmount] = useState(0);
  const [wagerMode, setWagerMode] = useState<'free_play' | 'slayer' | 'snake' | null>(null);
  const [targetKills, setTargetKills] = useState<number | undefined>(undefined);
  const [selectedLobbyMode, setSelectedLobbyMode] = useState<'free_play' | 'slayer' | 'snake' | null>(null);

  const handlePlayComputer = (player: { difficulty: number }, mode: 'free_play' | 'slayer' | 'snake') => {
    setDifficulty(player.difficulty);
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

  const handleFindGame = (mode: 'free_play' | 'slayer' | 'snake') => {
    // Start multiplayer mode (bots disabled)
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
            <CellsLobby 
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
            <ArgarGame 
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
            gameTitle="Neon Cells"
            onCancel={() => setGameState('lobby')}
            onStart={handleStartWager}
            fixedMode={selectedLobbyMode || undefined}
          />
        </div>
      )}
    </div>
  );
};

export default CellsGame;
