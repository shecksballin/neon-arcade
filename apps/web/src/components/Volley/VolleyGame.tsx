import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import VolleyLobby from './VolleyLobby';
import PingPongGame from './PingPongGame';
import { WagerMenu } from '../NeonBucks/WagerMenu';

interface VolleyGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inSession: boolean) => void;
}

const socket = io();

const VolleyGame = ({ onExit, profile, onGameStatusChange }: VolleyGameProps) => {
  const [gameState, setGameState] = useState<'lobby' | 'waiting' | 'playing' | 'practice_wager'>('lobby');
  const [gameMode, setGameMode] = useState<'multiplayer' | 'computer' | null>(null);
  const [playerInfo, setPlayerInfo] = useState<{ name: string; avatarUrl: string; difficulty?: number; matchMode: 'classic' | 'bestof3' | 'sudden' } | null>(null);
  const [gameData, setGameData] = useState<any>(null);
  const [settings, setSettings] = useState({ ghostMode: false, minimalistMode: false });
  const [wagerAmount, setWagerAmount] = useState<number>(0);

  useEffect(() => {
    onGameStatusChange?.(gameState !== 'lobby');
  }, [gameState, onGameStatusChange]);

  useEffect(() => {
    socket.on('waiting', () => setGameState('waiting'));
    
    socket.on('volleyGameStart', (data: any) => {
      setGameData(data);
      setGameMode('multiplayer');
      setGameState('playing');
    });

    socket.on('opponentDisconnected', () => {
      if (gameState === 'playing') {
        alert('Opponent disconnected');
        setGameState('lobby');
      }
    });

    return () => {
      socket.off('waiting');
      socket.off('volleyGameStart');
      socket.off('opponentDisconnected');
    };
  }, [gameState]);

  const handleFindGame = (player: { matchMode: 'classic' | 'bestof3' | 'sudden' }) => {
    const fullPlayerInfo = { 
      ...player, 
      name: profile?.name || 'Player', 
      avatarUrl: profile?.avatarUrl || 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix' 
    };
    setPlayerInfo(fullPlayerInfo);
    socket.emit('findVolleyGame', fullPlayerInfo);
  };

  const handlePlayComputer = (player: { difficulty: number; matchMode: 'classic' | 'bestof3' | 'sudden' }) => {
    const fullPlayerInfo = { 
      ...player, 
      name: profile?.name || 'Player', 
      avatarUrl: profile?.avatarUrl || 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix' 
    };
    setPlayerInfo(fullPlayerInfo);
    setGameState('practice_wager');
  };

  const handleExitGame = () => {
    setGameState('lobby');
    setGameMode(null);
    setPlayerInfo(null);
    setGameData(null);
  };

  return (
    <div className="h-full w-full bg-[#081616]">
      <AnimatePresence mode="wait">
        {gameState === 'lobby' && (
          <motion.div key="lobby" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full w-full">
            <VolleyLobby 
              onFindGame={handleFindGame}
              onPlayComputer={handlePlayComputer}
              onExit={onExit}
              settings={settings}
              onSettingsChange={setSettings}
            />
          </motion.div>
        )}

        {gameState === 'practice_wager' && (
           <motion.div key="wager" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full w-full flex items-center justify-center relative">
             {/* Render Lobby behind it statically if needed, or just let menu take over */}
             <VolleyLobby 
               onFindGame={handleFindGame}
               onPlayComputer={handlePlayComputer}
               onExit={onExit}
               settings={settings}
               onSettingsChange={setSettings}
             />
             <WagerMenu 
               gameTitle="Neon Volley"
               onCancel={() => setGameState('lobby')}
               onStart={(stake) => {
                 setWagerAmount(stake);
                 setGameMode('computer');
                 setGameState('playing');
               }}
             />
           </motion.div>
        )}

        {gameState === 'waiting' && (
          <motion.div key="waiting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full w-full flex flex-col items-center justify-center p-6 text-center">
            <div className="relative mb-12">
              <div className="w-32 h-32 border-4 border-[#00FFD1]/20 rounded-full"></div>
              <div className="absolute top-0 left-0 w-32 h-32 border-4 border-[#00FFD1] border-t-transparent rounded-full animate-spin"></div>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="material-symbols-outlined text-4xl text-[#00FFD1] animate-pulse">radar</span>
              </div>
            </div>
            <h2 className="text-4xl font-black text-white italic uppercase tracking-tighter mb-4">Searching Global Mesh...</h2>
            <button onClick={() => setGameState('lobby')} className="px-8 py-3 border border-[#00FFD1] text-[#00FFD1] rounded-xl font-mono text-xs uppercase tracking-widest">Abort Uplink</button>
          </motion.div>
        )}

        {gameState === 'playing' && playerInfo && (
          <motion.div key="playing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full w-full">
            <PingPongGame 
               socket={socket}
               mode={gameMode!}
               playerData={playerInfo}
               gameData={gameData}
               onExit={onExit}
               settings={settings}
               wagerAmount={wagerAmount}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default VolleyGame;
