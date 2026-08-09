import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { Globe, Cpu, LogOut, Users, Trophy, TrendingUp, Settings, Award, MessageSquare, History } from 'lucide-react';
import { ParticleCard } from '../glass/MagicGameTile';
import GameLobby from './GameLobby';
import ComputerGame from './ComputerGame';
import OnlineGame from './OnlineGame';
import LocalGame from './LocalGame';
import { useComputerMove } from './useComputerMove';
import { DEFAULT_SKILL_LEVEL } from './difficulty';

interface ChessGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inProgress: boolean) => void;
}

const socket = io();

// Internal component for the left nav sidebar (based on SidebarMenu)
function ChessNavSidebar({ 
  gameTitle = "Neon Chess",
  onReturn, 
  onExit,
  gameMode, 
  onPlayOnline, 
  onPlayComputer, 
  onPlayLocal,
  profile
}: { 
  gameTitle?: string;
  onReturn: () => void;
  onExit: () => void;
  gameMode: string | null;
  onPlayOnline: () => void;
  onPlayComputer: () => void;
  onPlayLocal: () => void;
  profile: { name: string; avatarUrl: string } | null;
}) {
  return (
    <div className="w-64 border-r border-[#00FFD1]/20 bg-[#040b0b] flex flex-col h-screen sticky top-0 overflow-hidden shrink-0 z-50">
      <div className="flex items-center justify-between p-4 border-b border-[#00ffd1]/20 bg-gradient-to-r from-[#00ffd1]/10 to-transparent">
        <h2 className="text-lg font-black text-[#00ffd1] uppercase tracking-[0.2em]">{gameTitle} Menu</h2>
      </div>

      <div className="flex-1 p-2.5 flex flex-col gap-2.5">
        {/* Rank Section */}
        <div className="p-3 border border-[#00ffd1]/20 rounded-xl bg-black/40">
          <div className="flex items-center gap-2 mb-1.5">
            <Trophy size={18} className="text-[#00ffd1] shrink-0" />
            <div>
              <div className="text-[10px] text-[#00ffd1]/60 uppercase tracking-widest leading-none mt-0.5">Current Rank</div>
              <div className="text-base mt-1 text-white font-bold tracking-wider leading-none">DIAMOND I</div>
            </div>
          </div>
          <div className="w-full bg-black/60 h-1.5 rounded-full mt-2 overflow-hidden">
            <div className="bg-[#00ffd1] h-full w-[75%] shadow-[0_0_10px_#00ffd1]"></div>
          </div>
        </div>

        {/* Navigation Items */}
        <div className="space-y-1">
          <button className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-[#00ffd1]/10 text-white/70 hover:text-[#00ffd1] transition-colors border border-transparent hover:border-[#00ffd1]/30 cursor-pointer">
            <Users size={16} />
            <span className="uppercase tracking-wider text-xs flex-1 text-left">Friends</span>
            <span className="bg-[#00ffd1]/20 text-[#00ffd1] text-[9px] px-1.5 py-0.5 rounded flex items-center justify-center font-bold">5</span>
          </button>
          <button className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-[#00ffd1]/10 text-white/70 hover:text-[#00ffd1] transition-colors border border-transparent hover:border-[#00ffd1]/30 cursor-pointer">
            <MessageSquare size={16} />
            <span className="uppercase tracking-wider text-xs flex-1 text-left">Messages</span>
            <span className="bg-[#00ffd1]/20 text-[#00ffd1] text-[9px] px-1.5 py-0.5 rounded flex items-center justify-center font-bold">2</span>
          </button>
          <button className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-[#00ffd1]/10 text-white/70 hover:text-[#00ffd1] transition-colors border border-transparent hover:border-[#00ffd1]/30 cursor-pointer">
            <History size={16} />
            <span className="uppercase tracking-wider text-xs flex-1 text-left">{gameTitle} History</span>
          </button>
          <button className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-[#00ffd1]/10 text-white/70 hover:text-[#00ffd1] transition-colors border border-transparent hover:border-[#00ffd1]/30 cursor-pointer">
            <Award size={16} />
            <span className="uppercase tracking-wider text-xs flex-1 text-left">Leaderboard</span>
          </button>
          <button className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-[#00ffd1]/10 text-white/70 hover:text-[#00ffd1] transition-colors border border-transparent hover:border-[#00ffd1]/30 cursor-pointer">
            <TrendingUp size={16} />
            <span className="uppercase tracking-wider text-xs flex-1 text-left">Stats</span>
          </button>
          <button className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-[#00ffd1]/10 text-white/70 hover:text-[#00ffd1] transition-colors border border-transparent hover:border-[#00ffd1]/30 cursor-pointer">
            <Settings size={16} />
            <span className="uppercase tracking-wider text-xs flex-1 text-left">Settings</span>
          </button>
        </div>

        {/* Placeholder Friends List */}
        <div className="pt-2 border-t border-[#00ffd1]/20 flex-1 flex flex-col min-h-0 pb-4">
          <div className="text-[10px] text-white/40 uppercase tracking-[0.2em] mb-2 pl-2 shrink-0">Online Friends</div>
          <div className="space-y-1 overflow-y-auto custom-scrollbar flex-1">
            <div className="flex items-center justify-between p-2 rounded-lg hover:bg-white/5 cursor-pointer transition-colors group">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#00ffd1]/40 to-blue-500/40 border border-[#00ffd1]/20" />
                  <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#081616] bg-purple-500" />
                </div>
                <div className="text-left">
                  <div className="text-sm text-white/90 group-hover:text-white transition-colors tracking-wide leading-none">CyberNinja</div>
                  <div className="text-[10px] text-purple-400 mt-1">In Game</div>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between p-2 rounded-lg hover:bg-white/5 cursor-pointer transition-colors group">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#00ffd1]/40 to-blue-500/40 border border-[#00ffd1]/20" />
                  <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#081616] bg-green-500" />
                </div>
                <div className="text-left">
                  <div className="text-sm text-white/90 group-hover:text-white transition-colors tracking-wide leading-none">GlitchMatrix</div>
                  <div className="text-[10px] text-green-400 mt-1">Online</div>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between p-2 rounded-lg hover:bg-white/5 cursor-pointer transition-colors group">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#00ffd1]/40 to-blue-500/40 border border-[#00ffd1]/20" />
                  <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#081616] bg-yellow-500" />
                </div>
                <div className="text-left">
                  <div className="text-sm text-white/90 group-hover:text-white transition-colors tracking-wide leading-none">NeonRider</div>
                  <div className="text-[10px] text-yellow-400 mt-1">Away</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function GameMenuPanel({ 
  onReturn, 
  onExit,
  gameMode, 
  onPlayOnline, 
  onPlayComputer, 
  onPlayLocal,
  profile
}: { 
  onReturn: () => void, 
  onExit: () => void,
  gameMode: string | null,
  onPlayOnline: () => void,
  onPlayComputer: () => void,
  onPlayLocal: () => void,
  profile: { name: string; avatarUrl: string } | null
}) {
  return (
    <div className="w-full h-full px-1 flex flex-col gap-2 items-stretch pb-1">
      <div className="w-full flex flex-col justify-start gap-2 flex-1">
        {/* Online Match */}
        <ParticleCard
          onClick={onPlayOnline}
          className={`magic-bento-card flex-1 px-3 py-3.5 rounded-xl transition-all duration-300 flex flex-col items-center justify-center gap-1.5 group relative overflow-hidden cursor-pointer ${
            gameMode === 'multiplayer'
              ? 'bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] shadow-[0_0_40px_rgba(0,255,209,0.4)] scale-[1.02]'
              : 'bg-[#081616] border border-[#00FFD1]/40 text-white hover:border-[#00FFD1] hover:shadow-[0_0_20px_rgba(0,255,209,0.2)]'
          }`}
          style={{ backdropFilter: 'none' }}
        >
          {gameMode === 'multiplayer' && <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>}
          <Globe className={`w-5 h-5 shrink-0 ${gameMode === 'multiplayer' ? '' : 'text-zinc-400 group-hover:rotate-12 transition-transform block'}`} />
          <div className="text-center">
            <span className="block font-black text-[10px] uppercase tracking-tighter italic leading-none">
              Online Match
            </span>
          </div>
        </ParticleCard>

        {/* Practice / Computer */}
        <ParticleCard
          onClick={onPlayComputer}
          className={`magic-bento-card flex-1 px-3 py-3.5 rounded-xl transition-all duration-300 flex flex-col items-center justify-center gap-1.5 group relative overflow-hidden cursor-pointer ${
            gameMode === 'computer'
              ? 'bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] shadow-[0_0_40px_rgba(0,255,209,0.4)] scale-[1.02]'
              : 'bg-[#081616] border border-[#00FFD1]/40 text-white hover:border-[#00FFD1] hover:shadow-[0_0_20px_rgba(0,255,209,0.2)]'
          }`}
          style={{ backdropFilter: 'none' }}
        >
          {gameMode === 'computer' && <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>}
          <Cpu className={`w-5 h-5 shrink-0 ${gameMode === 'computer' ? '' : 'text-zinc-400 group-hover:rotate-12 transition-transform block'}`} />
          <div className="text-center">
            <span className="block font-black text-[10px] uppercase tracking-tighter italic leading-none">
              Practice
            </span>
          </div>
        </ParticleCard>

        {/* Local Co-Op */}
        <ParticleCard
          onClick={onPlayLocal}
          className={`magic-bento-card flex-1 px-3 py-3.5 rounded-xl transition-all duration-300 flex flex-col items-center justify-center gap-1.5 group relative overflow-hidden cursor-pointer ${
            gameMode === 'local'
              ? 'bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] shadow-[0_0_40px_rgba(0,255,209,0.4)] scale-[1.02]'
              : 'bg-[#081616] border border-[#00FFD1]/40 text-white hover:border-[#00FFD1] hover:shadow-[0_0_20px_rgba(0,255,209,0.2)]'
          }`}
          style={{ backdropFilter: 'none' }}
        >
          {gameMode === 'local' && <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>}
          <div className={`material-symbols-outlined text-[20px] block leading-none shrink-0 ${gameMode === 'local' ? '' : 'text-zinc-400 group-hover:scale-110 transition-transform'}`}>
            people
          </div>
          <div className="text-center">
            <span className="block font-black text-[10px] uppercase tracking-tighter italic leading-none">
              Local Co-Op
            </span>
          </div>
        </ParticleCard>
      </div>

      <div className="w-full mt-auto border-t border-[#3a4a44]/40 pt-2 pb-2 space-y-2 flex-shrink-0">
        {/* User Profile display */}
        {profile && (
          <div className="flex items-center gap-2 justify-center px-3 py-3 bg-[#081616] border border-[#00FFD1]/20 rounded-xl">
            <img src={profile.avatarUrl} alt="Avatar" className="w-5 h-5 rounded-full border border-[#00FFD1]/40" />
            <span className="text-[10px] font-black text-white italic uppercase tracking-tighter">
              {profile.name}
            </span>
          </div>
        )}

        <button
          onClick={onExit}
          className="w-full px-3 py-4 border border-red-500/40 text-red-400 rounded-xl transition-all flex items-center justify-center gap-1.5 group hover:scale-[1.02] cursor-pointer hover:bg-red-500/10 hover:border-red-500/60 font-black tracking-widest uppercase text-[10px]"
        >
          <LogOut className="w-3.5 h-3.5 group-hover:-translate-x-1 transition-transform inline-block pointer-events-none" />
          <span className="pointer-events-none">EXIT GAME</span>
        </button>
      </div>
    </div>
  );
}

import { WagerMenu } from '../NeonBucks/WagerMenu';
import { useNeonBucks } from '../../NeonBucksStore';

export default function ChessGame({ onExit, profile, onGameStatusChange }: ChessGameProps) {
  const [gameState, setGameState] = useState<'lobby' | 'waiting' | 'playing' | 'ended' | 'practice_wager'>('lobby');
  const [playerData, setPlayerData] = useState<any>(null);
  const [gameData, setGameData] = useState<any>(null);
  const [gameMode, setGameMode] = useState<'multiplayer' | 'computer' | 'local' | null>(null);
  const [wagerAmount, setWagerAmount] = useState<number>(0);
  // Practice-mode engine strength (Stockfish skill level), shared by the
  // lobby selector and the in-game selector.
  const [skillLevel, setSkillLevel] = useState<number>(DEFAULT_SKILL_LEVEL);

  const [externalMove, setExternalMove] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'waiting' | 'disconnected'>('disconnected');

  const { getBestMove } = useComputerMove();

  useEffect(() => {
    if (onGameStatusChange) {
      onGameStatusChange(gameState !== 'lobby');
    }
  }, [gameState, onGameStatusChange]);

  useEffect(() => {
    socket.on('connect', () => {
      setConnectionStatus('connected');
    });

    socket.on('disconnect', () => {
      setConnectionStatus('disconnected');
    });

    socket.on('waiting', () => {
      setGameState('waiting');
      setConnectionStatus('waiting');
    });

    socket.on('gameStart', (data: any) => {
      setGameState('playing');
      setGameData(data);
      setGameMode(data.mode);
      setConnectionStatus('connected');
    });

    socket.on('gameEnded', (data: any) => {
      setGameState('ended');
    });

    socket.on('opponentDisconnected', () => {
      setGameState('lobby');
      setGameData(null);
      setGameMode(null);
      setConnectionStatus('disconnected');
    });

    socket.on('moveMade', (data: any) => {
      setExternalMove(data.move);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('waiting');
      socket.off('gameStart');
      socket.off('gameEnded');
      socket.off('opponentDisconnected');
      socket.off('moveMade');
    };
  }, []);

  const handleFindGame = () => {
    const fullPlayer = { 
      name: profile?.name || 'Player',
      avatarUrl: profile?.avatarUrl || 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix'
    };
    setPlayerData(fullPlayer);
    socket.emit('findGame', fullPlayer);
  };

  const handlePlayComputer = () => {
    const fullPlayer = {
      name: profile?.name || 'Player',
      avatarUrl: profile?.avatarUrl || 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix'
    };
    setPlayerData(fullPlayer);
    setGameState('practice_wager');
  };

  const handlePlayLocal = () => {
    setGameMode('local');
    setGameState('playing');
  };

  const handleExitApp = () => {
    if (gameState === 'waiting') {
      socket.emit('leaveQueue');
    }
    if (gameMode === 'multiplayer' && gameState === 'playing' && gameData?.gameId) {
      socket.emit('resign', gameData.gameId);
    }
    onExit();
  };

  const handleReturnToLobby = () => {
    if (gameState === 'waiting') {
      socket.emit('leaveQueue');
    }
    if (gameMode === 'multiplayer' && gameState === 'playing' && gameData?.gameId) {
      socket.emit('resign', gameData.gameId);
    }
    setGameState('lobby');
    setGameData(null);
    setGameMode(null);
    setPlayerData(null);
    setExternalMove(null);
  };

  if (gameState === 'lobby' || gameState === 'practice_wager') {
    return (
      <div className="min-h-screen bg-[#081616] relative flex justify-center">
        {gameState === 'practice_wager' && (
          <WagerMenu 
            gameTitle="Neon Chess"
            onCancel={() => setGameState('lobby')}
            onStart={(stake) => {
              setWagerAmount(stake);
              setGameMode('computer');
              setGameState('playing');
            }}
          />
        )}
        <div className="w-full relative z-0">
          <GameLobby
            onFindGame={handleFindGame}
            onPlayComputer={handlePlayComputer}
            onPlayLocal={handlePlayLocal}
            onExit={onExit}
            difficulty={skillLevel}
            onDifficultyChange={setSkillLevel}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-[#081616] overflow-hidden">
      {/* Permanent Left Sidebar (Nav & Actions) */}
      <ChessNavSidebar 
        gameTitle="Neon Chess" 
        onReturn={handleReturnToLobby}
        onExit={handleExitApp}
        gameMode={gameMode}
        onPlayOnline={gameMode === 'multiplayer' ? () => {} : handleFindGame}
        onPlayComputer={gameMode === 'computer' ? () => {} : handlePlayComputer}
        onPlayLocal={gameMode === 'local' ? () => {} : handlePlayLocal}
        profile={profile}
      />

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto h-screen relative">
        {gameState === 'waiting' ? (
          <div className="min-h-screen flex items-center justify-center p-6">
            <div className="text-center space-y-8 max-w-md w-full">
              <h1 className="text-4xl font-black text-[#FFFFFD] neon-text-glow uppercase italic">Searching Arena...</h1>
              <div className="flex justify-center gap-3">
                <div className="w-4 h-4 bg-[#00FFD1] rounded-full animate-bounce shadow-[0_0_10px_#00ffd1]"></div>
                <div className="w-4 h-4 bg-[#00FFD1] rounded-full animate-bounce shadow-[0_0_10px_#00ffd1]" style={{ animationDelay: '0.2s' }}></div>
                <div className="w-4 h-4 bg-[#00FFD1] rounded-full animate-bounce shadow-[0_0_10px_#00ffd1]" style={{ animationDelay: '0.4s' }}></div>
              </div>
              <p className="text-[#B1C5FF] font-mono text-sm tracking-widest uppercase opacity-60">Scanning for rivals across the grid</p>
              <button
                onClick={handleReturnToLobby}
                className="mt-12 px-8 py-3 border border-[#00FFD1] text-[#00FFD1] rounded-xl hover:bg-[#00FFD1]/10 transition-all font-mono text-xs uppercase tracking-widest"
              >
                Cancel Search
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center py-10 min-h-full gap-8 max-w-[1200px] mx-auto translate-y-[20px]">
            {/* The 5 buttons menu on the left */}
            <div className="w-[280px] h-[600px] flex-shrink-0">
               <GameMenuPanel 
                 onReturn={handleReturnToLobby} 
                 onExit={handleExitApp}
                 gameMode={gameMode} 
                 onPlayOnline={gameMode === 'multiplayer' ? () => {} : handleFindGame}
                 onPlayComputer={gameMode === 'computer' ? () => {} : handlePlayComputer}
                 onPlayLocal={gameMode === 'local' ? () => {} : handlePlayLocal}
                 profile={profile}
               />
            </div>

            {gameMode === 'local' ? (
              <LocalGame
                onReturnToLobby={handleReturnToLobby}
                profile={profile}
              />
            ) : gameMode === 'computer' ? (
              <ComputerGame
                onRequestComputerMove={(fen: string, diff: number) => getBestMove(fen, { skillLevel: diff })}
                playerColor="white"
                difficulty={skillLevel}
                onDifficultyChange={setSkillLevel}
                onReturnToLobby={handleReturnToLobby}
                profile={profile}
                wagerAmount={wagerAmount}
              />
            ) : (
              <OnlineGame
                playerColor={gameData?.whitePlayer?.socketId === socket.id ? 'white' : 'black'}
                connectionStatus={connectionStatus}
                externalMove={externalMove}
                profile={profile}
                onSendMove={(uci: string, fen: string) => {
                  socket.emit('makeMove', { gameId: gameData?.gameId, move: uci, fen });
                }}
                gameId={gameData?.gameId}
                opponentName={gameData?.whitePlayer?.socketId === socket.id ? gameData?.blackPlayer?.name : gameData?.whitePlayer?.name}
                playerName={playerData?.name}
                onReturnToLobby={handleReturnToLobby}
                onRematchRequest={() => {}}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
