import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import VolleyLobby from './VolleyLobby';
import PingPongGame from './PingPongGame';
import { WagerMenu } from '../NeonBucks/WagerMenu';
// Shared authed game socket — connects lazily when matchmaking starts, never
// at module import.
import { connectGameSocket, getSocket } from '../../hooks/useGameSocket';

interface VolleyGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inSession: boolean) => void;
}

const VolleyGame = ({ onExit, profile, onGameStatusChange }: VolleyGameProps) => {
  const [gameState, setGameState] = useState<'lobby' | 'waiting' | 'playing' | 'practice_wager'>('lobby');
  const [gameMode, setGameMode] = useState<'multiplayer' | 'computer' | null>(null);
  const [playerInfo, setPlayerInfo] = useState<{ name: string; avatarUrl: string; difficulty?: number; matchMode: 'classic' | 'bestof3' | 'sudden' } | null>(null);
  const [gameData, setGameData] = useState<any>(null);
  const [settings, setSettings] = useState({ ghostMode: false, minimalistMode: false });
  const [wagerAmount, setWagerAmount] = useState<number>(0);

  // Singleton — stable across renders, NOT connected until connectGameSocket().
  const socket = getSocket();

  useEffect(() => {
    onGameStatusChange?.(gameState !== 'lobby');
  }, [gameState, onGameStatusChange]);

  useEffect(() => {
    // Named handlers + handler-specific socket.off — the socket is shared
    // with the other games, so blanket .off('event') would strip theirs.
    const onWaiting = () => setGameState('waiting');
    const onVolleyGameStart = (data: any) => {
      setGameData(data);
      setGameMode('multiplayer');
      setGameState('playing');
    };
    const onOpponentDisconnected = () => {
      if (gameState === 'playing') {
        alert('Opponent disconnected');
        setGameState('lobby');
      }
    };
    const onConnectError = (err: Error) => {
      // Auth rejection while queueing would leave us stuck on the radar
      // screen forever — bail back to the lobby.
      if (err.message === 'unauthorized' || err.message === 'auth_unavailable') {
        console.warn('[volley] socket auth failed:', err.message);
        setGameState((s) => (s === 'waiting' ? 'lobby' : s));
      }
    };
    const onGameAuthError = (data: any) => {
      // Server refused matchmaking (e.g. account setup unfinished).
      console.warn('[volley] cannot play online:', data?.message ?? data?.code);
      setGameState((s) => (s === 'waiting' ? 'lobby' : s));
    };

    socket.on('waiting', onWaiting);
    socket.on('volleyGameStart', onVolleyGameStart);
    socket.on('opponentDisconnected', onOpponentDisconnected);
    socket.on('connect_error', onConnectError);
    socket.on('gameAuthError', onGameAuthError);

    return () => {
      socket.off('waiting', onWaiting);
      socket.off('volleyGameStart', onVolleyGameStart);
      socket.off('opponentDisconnected', onOpponentDisconnected);
      socket.off('connect_error', onConnectError);
      socket.off('gameAuthError', onGameAuthError);
    };
  }, [gameState, socket]);

  // Free our queue slot if the whole component unmounts mid-search (the
  // Abort button below covers the in-app path).
  const gameStateRef = useRef(gameState);
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);
  useEffect(() => {
    return () => {
      if (gameStateRef.current === 'waiting') socket.emit('leaveVolleyQueue');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFindGame = (player: { matchMode: 'classic' | 'bestof3' | 'sudden' }) => {
    const fullPlayerInfo = {
      ...player,
      name: profile?.name || 'Player',
      avatarUrl: profile?.avatarUrl || 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix'
    };
    setPlayerInfo(fullPlayerInfo);
    // Lazy connect: only touches the network when entering online mode.
    connectGameSocket();
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
            <button
              onClick={() => {
                // Tell the server to drop our queue entry — without this the
                // 'aborted' player could still get yanked into a match.
                socket.emit('leaveVolleyQueue');
                setGameState('lobby');
              }}
              className="px-8 py-3 border border-[#00FFD1] text-[#00FFD1] rounded-xl font-mono text-xs uppercase tracking-widest"
            >Abort Uplink</button>
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
