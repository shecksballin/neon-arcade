import React, { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronLeft,
  Gamepad2,
  Brain,
  Globe,
  History,
  Trophy,
  RefreshCw,
  User,
  Cpu,
  Users,
  LogOut,
  TrendingUp,
  Settings,
  Award,
  MessageSquare,
  Undo2,
  Plus, CircleDollarSign } from 'lucide-react';
import { io, Socket } from "socket.io-client";
import { LibraryBlob } from "../glass/LibraryBlob";
import { WagerMenu } from "../NeonBucks/WagerMenu";
import { ResultsScreen } from "../NeonBucks/ResultsScreen";
import { useNeonBucks } from "../../NeonBucksStore";
import { ParticleCard, GlobalSpotlight } from "../glass/MagicGameTile";
import { DifficultySelector } from "../common/DifficultySelector";
import {
  CONNECT_DIFFICULTIES,
  CONNECT_DEFAULT_DIFFICULTY,
  connectAiConfig,
  connectDifficultyCaption,
} from "./connectDifficulty";
import { chooseConnectAiMove } from "./connectAi";

function ConnectHistoryPanel({
  history,
  onUndo,
  onNewGame
}: {
  history: { col: number; player: number }[],
  onUndo?: () => void,
  onNewGame?: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history]);

  const pairs = [];
  for (let i = 0; i < history.length; i += 2) {
    pairs.push({ number: Math.floor(i / 2) + 1, white: history[i], black: history[i + 1] });
  }

  return (
    <div className="flex flex-col w-full h-full bg-[#041010] overflow-hidden rounded shadow-lg border border-[#00ffd1]/20" style={{ fontFamily: 'var(--font-sans)', borderRadius: '0.5rem' }}>
      {/* Moves List */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto w-full custom-scrollbar block"
      >
        {pairs.length === 0 && (
           <div className="p-4 text-[#00ffd1]/60 text-xs font-semibold text-center italic mt-4">
             No moves yet
           </div>
        )}
        {pairs.map(({ number, white, black }, index) => (
          <div key={number} className={`flex text-sm font-semibold tracking-wide ${index % 2 === 0 ? 'bg-transparent' : 'bg-[#00ffd1]/5'}`}>
             <div className="w-[15%] min-w-[36px] text-[#00ffd1]/60 border-r border-[#00ffd1]/20 flex items-center justify-center py-1 text-xs">
               {number}.
             </div>
             <div className="w-[42.5%] px-3 py-1 flex items-center text-[#e0e0e0] hover:bg-[#00ffd1]/20 cursor-pointer transition-colors border-r border-[#00ffd1]/20">
               {white ? `Col ${white.col}` : ''}
             </div>
             <div className="w-[42.5%] px-3 py-1 flex items-center text-[#e0e0e0] hover:bg-[#00ffd1]/20 cursor-pointer transition-colors">
               {black ? `Col ${black.col}` : ''}
             </div>
          </div>
        ))}
      </div>

      {/* Control Buttons */}
      <div className="bg-[#00ffd1]/10 flex items-center justify-between p-2 border-t border-[#00ffd1]/30">
         <div className="flex gap-1 ml-2">
           {onNewGame && (
             <button 
               onClick={onNewGame}
               title="New Game"
               className="text-[#00ffd1]/80 hover:text-[#00ffd1] p-1.5 rounded hover:bg-[#00ffd1]/20 transition-colors flex items-center gap-1"
             >
               <Plus size={16} />
             </button>
           )}
           {onUndo && (
             <button 
               onClick={onUndo}
               title="Reverse Move"
               className="text-[#00ffd1]/80 hover:text-[#00ffd1] p-1.5 rounded hover:bg-[#00ffd1]/20 transition-colors"
             >
               <Undo2 size={16} />
             </button>
           )}
         </div>
      </div>
    </div>
  );
}

function ConnectNavSidebar({ 
  gameTitle = "Neon Connect",
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
            gameMode === 'multiplayer' || gameMode === 'online'
              ? 'bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] shadow-[0_0_40px_rgba(0,255,209,0.4)] scale-[1.02]'
              : 'bg-[#081616] border border-[#00FFD1]/40 text-white hover:border-[#00FFD1] hover:shadow-[0_0_20px_rgba(0,255,209,0.2)]'
          }`}
          style={{ backdropFilter: 'none' }}
        >
          {(gameMode === 'multiplayer' || gameMode === 'online') && <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>}
          <Globe className={`w-5 h-5 shrink-0 ${gameMode === 'multiplayer' || gameMode === 'online' ? '' : 'text-zinc-400 group-hover:rotate-12 transition-transform block'}`} />
          <div className="text-center">
            <span className="block font-black text-[10px] uppercase tracking-tighter italic leading-none">Wager Match</span>
          </div>
        </ParticleCard>

        {/* Practice / Computer */}
        <ParticleCard
          onClick={onPlayComputer}
          className={`magic-bento-card flex-1 px-3 py-3.5 rounded-xl transition-all duration-300 flex flex-col items-center justify-center gap-1.5 group relative overflow-hidden cursor-pointer ${
            gameMode === 'computer' || gameMode === 'local' // Map 'local' mode in connect to Practice/Computer
              ? 'bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] shadow-[0_0_40px_rgba(0,255,209,0.4)] scale-[1.02]'
              : 'bg-[#081616] border border-[#00FFD1]/40 text-white hover:border-[#00FFD1] hover:shadow-[0_0_20px_rgba(0,255,209,0.2)]'
          }`}
          style={{ backdropFilter: 'none' }}
        >
          {(gameMode === 'computer' || gameMode === 'local') && <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>}
          <Cpu className={`w-5 h-5 shrink-0 ${(gameMode === 'computer' || gameMode === 'local') ? '' : 'text-zinc-400 group-hover:rotate-12 transition-transform block'}`} />
          <div className="text-center">
            <span className="block font-black text-[10px] uppercase tracking-tighter italic leading-none">
              Practice
            </span>
          </div>
        </ParticleCard>

        {/* Local Co-Op (Placeholder in Connect for layout) */}
        <ParticleCard
          onClick={onPlayLocal}
          className={`magic-bento-card flex-1 px-3 py-3.5 rounded-xl transition-all duration-300 flex flex-col items-center justify-center gap-1.5 group relative overflow-hidden cursor-pointer ${
            gameMode === 'local_coop'
              ? 'bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] shadow-[0_0_40px_rgba(0,255,209,0.4)] scale-[1.02]'
              : 'bg-[#081616] border border-[#00FFD1]/40 text-white hover:border-[#00FFD1] hover:shadow-[0_0_20px_rgba(0,255,209,0.2)]'
          }`}
          style={{ backdropFilter: 'none' }}
        >
          {(gameMode === 'local_coop') && <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>}
          <div className={`material-symbols-outlined text-[20px] block leading-none shrink-0 ${gameMode === 'local_coop' ? '' : 'text-zinc-400 group-hover:scale-110 transition-transform'}`}>
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

const ROWS = 6;
const COLS = 7;
const EMPTY = 0;
const HUMAN = 1;
const OPPONENT = 2;

interface Move {
  col: number;
  player: number;
}

interface NeonConnectGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inGame: boolean) => void;
}

const NeonConnectGame: React.FC<NeonConnectGameProps> = ({
  onExit,
  profile,
  onGameStatusChange,
}) => {
  const [mode, setMode] = useState<"lobby" | "local" | "local_coop" | "online" | "practice_wager">("lobby");
  const [board, setBoard] = useState<number[]>(Array(ROWS * COLS).fill(EMPTY));
  const [currentPlayer, setCurrentPlayer] = useState(HUMAN);
  const [gameStatus, setGameStatus] = useState<"playing" | "won" | "draw">(
    "playing",
  );
  const [winner, setWinner] = useState<number | null>(null);
  const [moveHistory, setMoveHistory] = useState<Move[]>([]);
  const [animatingColumn, setAnimatingColumn] = useState<number | null>(null);
  const [canPlay, setCanPlay] = useState(true);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [onlineOpponent, setOnlineOpponent] = useState<string | null>(null);
  const [myTurn, setMyTurn] = useState<boolean>(true);
  const [myPlayerId, setMyPlayerId] = useState<number>(HUMAN);
  const [wagerAmount, setWagerAmount] = useState<number>(0);
  // Computer-opponent strength (see connectDifficulty.ts). Persists across
  // resetGame so a chosen difficulty carries into the next practice game.
  const [aiDifficulty, setAiDifficulty] = useState<number>(CONNECT_DEFAULT_DIFFICULTY);
  const { win, balance } = useNeonBucks();

  const boardRef = useRef(board);
  const containerRef = useRef<HTMLDivElement>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const victoryBuffer = useRef<AudioBuffer | null>(null);
  const resultBuffer = useRef<AudioBuffer | null>(null);
  const soundPlayedRef = useRef(false);

  useEffect(() => {
    if (onGameStatusChange) {
      onGameStatusChange(mode !== "lobby");
    }
  }, [mode, onGameStatusChange]);

  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  // ==================== Audio Engine ====================
  useEffect(() => {
    audioContext.current = new (
      window.AudioContext || (window as any).webkitAudioContext
    )();

    const generateFallbackSound = (isVictory: boolean) => {
      if (!audioContext.current) return null;
      const duration = 1.5;
      const sampleRate = audioContext.current.sampleRate;
      const buffer = audioContext.current.createBuffer(
        1,
        sampleRate * duration,
        sampleRate,
      );
      const data = buffer.getChannelData(0);
      for (let i = 0; i < sampleRate * duration; i++) {
        const t = i / sampleRate;
        const freq = isVictory ? 440 + t * 440 : 440 - t * 220;
        data[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-2 * t) * 0.3;
      }
      return buffer;
    };

    const loadSound = async (url: string) => {
      try {
        const response = await fetch(url.startsWith("/") ? url.slice(1) : url);
        if (!response.ok) throw new Error(`Status: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        if (audioContext.current) {
          return await audioContext.current.decodeAudioData(arrayBuffer);
        }
      } catch (err) {
        return generateFallbackSound(url.includes("winning"));
      }
      return null;
    };

    const initSounds = async () => {
      victoryBuffer.current = await loadSound("winningresultsoundfx.mp3");
      resultBuffer.current = await loadSound("result.mp3");
    };

    initSounds();
    return () => {
      audioContext.current?.close();
    };
  }, []);

  const playResultSound = useCallback((isVictory: boolean) => {
    const buffer = isVictory ? victoryBuffer.current : resultBuffer.current;
    if (!audioContext.current || !buffer) return;
    if (audioContext.current.state === "suspended")
      audioContext.current.resume();
    const source = audioContext.current.createBufferSource();
    const gainNode = audioContext.current.createGain();
    source.buffer = buffer;
    gainNode.gain.value = 0.6;
    source.connect(gainNode);
    gainNode.connect(audioContext.current.destination);
    source.start(0);
  }, []);

  useEffect(() => {
    if (gameStatus !== "playing" && !soundPlayedRef.current) {
      const isVictory =
        mode === "online" ? winner === myPlayerId : winner === HUMAN;
      playResultSound(isVictory && gameStatus === "won");
      soundPlayedRef.current = true;
    } else if (gameStatus === "playing") {
      soundPlayedRef.current = false;
    }
  }, [gameStatus, winner, myPlayerId, mode, playResultSound]);

  // ==================== Stable Game Logic ====================

  const getAvailableRow = useCallback((col: number, currentBoard: number[]) => {
    for (let row = ROWS - 1; row >= 0; row--) {
      if (currentBoard[row * COLS + col] === EMPTY) {
        return row;
      }
    }
    return -1;
  }, []);

  const checkWin = useCallback((checkBoard: number[], player: number) => {
    // Horizontal
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS - 3; c++) {
        const i = r * COLS + c;
        if (
          checkBoard[i] === player &&
          checkBoard[i + 1] === player &&
          checkBoard[i + 2] === player &&
          checkBoard[i + 3] === player
        )
          return true;
      }
    }
    // Vertical
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS - 3; r++) {
        const i = r * COLS + c;
        if (
          checkBoard[i] === player &&
          checkBoard[i + COLS] === player &&
          checkBoard[i + COLS * 2] === player &&
          checkBoard[i + COLS * 3] === player
        )
          return true;
      }
    }
    // Diagonal /
    for (let r = 3; r < ROWS; r++) {
      for (let c = 0; c < COLS - 3; c++) {
        const i = r * COLS + c;
        if (
          checkBoard[i] === player &&
          checkBoard[i - COLS + 1] === player &&
          checkBoard[i - COLS * 2 + 2] === player &&
          checkBoard[i - COLS * 3 + 3] === player
        )
          return true;
      }
    }
    // Diagonal \
    for (let r = 0; r < ROWS - 3; r++) {
      for (let c = 0; c < COLS - 3; c++) {
        const i = r * COLS + c;
        if (
          checkBoard[i] === player &&
          checkBoard[i + COLS + 1] === player &&
          checkBoard[i + COLS * 2 + 2] === player &&
          checkBoard[i + COLS * 3 + 3] === player
        )
          return true;
      }
    }
    return false;
  }, []);

  const isBoardFull = useCallback(
    (checkBoard: number[]) => checkBoard.every((cell) => cell !== EMPTY),
    [],
  );

  // Primary Move Handler
  const executeMove = useCallback(
    (col: number, player: number) => {
      const currentBoard = boardRef.current;
      const row = getAvailableRow(col, currentBoard);
      if (row === -1) return null;

      const newBoard = [...currentBoard];
      newBoard[row * COLS + col] = player;
      setBoard(newBoard);

      const moveInfo = { col: col + 1, player };
      setMoveHistory((prev) => [...prev, moveInfo]);

      if (checkWin(newBoard, player)) {
        setGameStatus("won");
        setWinner(player);
        setCanPlay(false);

        // Payout if Practice (local) and Human Won
        if (mode === "local" && player === HUMAN && wagerAmount > 0) {
           win(wagerAmount * 2);
        }

        return { won: true };
      }

      if (isBoardFull(newBoard)) {
        setGameStatus("draw");
        setCanPlay(false);
        if (mode === "local" && wagerAmount > 0) {
           win(wagerAmount); // Return their money on draw
        }
        return { draw: true };
      }

      return { success: true };
    },
    [getAvailableRow, checkWin, isBoardFull],
  );

  // ==================== Interaction Handling ====================

  const handleUndo = useCallback(() => {
    if (mode === 'online' || moveHistory.length === 0 || gameStatus !== 'playing') return;
    const newHistory = [...moveHistory];
    newHistory.pop();
    if (mode === 'local' && newHistory.length > 0 && newHistory[newHistory.length - 1].player !== HUMAN) {
       newHistory.pop();
    }

    const newBoard = Array(ROWS * COLS).fill(EMPTY);
    let currentTurn = HUMAN;
    for (const m of newHistory) {
      for (let r = ROWS - 1; r >= 0; r--) {
        if (newBoard[r * COLS + (m.col - 1)] === EMPTY) {
          newBoard[r * COLS + (m.col - 1)] = m.player;
          break;
        }
      }
      currentTurn = m.player === HUMAN ? OPPONENT : HUMAN;
    }
    setMoveHistory(newHistory);
    setBoard(newBoard);
    setCurrentPlayer(currentTurn);
  }, [mode, moveHistory, gameStatus]);

  const handleColumnClick = useCallback(
    (col: number) => {
      if (!canPlay || gameStatus !== "playing" || animatingColumn !== null)
        return;
      if (mode === "online" && !myTurn) return;
      if (getAvailableRow(col, boardRef.current) === -1) return;

      setAnimatingColumn(col);

      // Artificial delay for "dropping" feel
      setTimeout(() => {
        const p = mode === "online" ? myPlayerId : currentPlayer;
        const result = executeMove(col, p);

        if (result) {
          if (mode === "online" && socket) {
            socket.emit("neonconnect_move", { col });
            setMyTurn(false);
          }

          if (
            gameStatus === "playing" &&
            !("won" in result) &&
            !("draw" in result)
          ) {
            if (mode === "local" || mode === "local_coop") {
              setCurrentPlayer((prev) => (prev === HUMAN ? OPPONENT : HUMAN));
            }
          }
        }
        setAnimatingColumn(null);
      }, 500);
    },
    [
      canPlay,
      gameStatus,
      animatingColumn,
      getAvailableRow,
      executeMove,
      currentPlayer,
      mode,
      socket,
      myTurn,
      myPlayerId,
    ],
  );

  // ==================== AI Controller ====================

  useEffect(() => {
    if (
      mode === "local" &&
      currentPlayer === OPPONENT &&
      gameStatus === "playing" &&
      canPlay
    ) {
      // AI "Thinking" state
      const aiTimer = setTimeout(() => {
        const move = chooseConnectAiMove(
          boardRef.current,
          connectAiConfig(aiDifficulty),
          { COLS, HUMAN, OPPONENT, getAvailableRow, checkWin },
        );
        if (move !== null) handleColumnClick(move);
      }, 800); // AI Thinking Delay

      return () => clearTimeout(aiTimer);
    }
  }, [
    currentPlayer,
    mode,
    gameStatus,
    canPlay,
    aiDifficulty,
    getAvailableRow,
    checkWin,
    handleColumnClick,
  ]);

  // ==================== Socket.io Integration ====================

  useEffect(() => {
    if (mode !== "online") return;

    const s = io();
    setSocket(s);

    s.emit("neonconnect_join", { profile });

    s.on(
      "neonconnect_match",
      (data: { opponent: string; turn: boolean; playerId: number }) => {
        setOnlineOpponent(data.opponent);
        setMyTurn(data.turn);
        setMyPlayerId(data.playerId);
        setCurrentPlayer(
          data.turn
            ? data.playerId
            : data.playerId === HUMAN
              ? OPPONENT
              : HUMAN,
        );
      },
    );

    s.on("neonconnect_opponent_move", (data: { col: number }) => {
      const { col } = data;
      setAnimatingColumn(col);
      const opponentId = myPlayerId === HUMAN ? OPPONENT : HUMAN;
      setTimeout(() => {
        const result = executeMove(col, opponentId);
        if (result) {
          if (
            gameStatus === "playing" &&
            !("won" in result) &&
            !("draw" in result)
          ) {
            setMyTurn(true);
            setCurrentPlayer(myPlayerId);
          }
        }
        setAnimatingColumn(null);
      }, 600);
    });

    s.on("neonconnect_opponent_quit", () => {
      setGameStatus("won");
      setWinner(myPlayerId);
      setCanPlay(false);
      setOnlineOpponent((prev) => (prev ? `${prev} (DISCONNECTED)` : null));
    });

    return () => {
      s.disconnect();
    };
  }, [mode, profile, myPlayerId, executeMove, gameStatus]);

  const resetGame = () => {
    setBoard(Array(ROWS * COLS).fill(EMPTY));
    setCurrentPlayer(HUMAN);
    setGameStatus("playing");
    setWinner(null);
    setMoveHistory([]);
    setAnimatingColumn(null);
    setCanPlay(true);
    if (mode === "online" && socket) {
      socket.emit("neonconnect_reset");
    }
  };

  if (mode === "lobby" || mode === "practice_wager") {
    return (
      <div className="min-h-screen bg-[#081616] flex flex-col items-center justify-center p-6 relative overflow-hidden">
        {mode === "practice_wager" && (
          <WagerMenu 
            gameTitle="Neon Connect"
            onCancel={() => setMode("lobby")}
            onStart={(stake) => {
               setWagerAmount(stake);
               setMode("local");
            }}
          />
        )}
        <LibraryBlob />
        <GlobalSpotlight gridRef={containerRef} />

        {/* Animated background highlights */}
        <div className="absolute inset-0 opacity-20 pointer-events-none">
          <div className="absolute top-20 left-20 w-96 h-96 bg-[#00FFD1] rounded-full blur-[120px] opacity-20 animate-pulse"></div>
          <div
            className="absolute bottom-20 right-20 w-96 h-96 bg-[#FF0080] rounded-full blur-[120px] opacity-20 animate-pulse"
            style={{ animationDelay: "1s" }}
          ></div>
        </div>

        <div ref={containerRef} className="relative z-10 text-center space-y-8 max-w-2xl w-full">
          <motion.div
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="space-y-2"
          >
            <h1 className="text-6xl md:text-8xl font-black text-[#FFFFFD] drop-shadow-[0_0_20px_rgba(0,255,209,0.6)] uppercase tracking-tighter italic">
              NEON CONNECT
            </h1>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full text-left">
            <ParticleCard
              onClick={() => {
                const wager = prompt("Enter wager amount:", "10");
                if (wager) {
                  alert("Wager mode not fully implemented in template.");
                }
              }}
              className="magic-bento-card magic-bento-card--border-glow px-4 py-6 bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] rounded-2xl hover:shadow-[0_0_50px_rgba(0,255,209,0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
            >
              <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>
              <CircleDollarSign className="w-8 h-8 group-hover:rotate-12 transition-transform" />
              <div className="text-center">
                <span className="block font-black text-lg md:text-xl uppercase tracking-tighter italic leading-none">
                  Wager Match
                </span>
                <span className="block text-[8px] opacity-60 font-bold tracking-widest mt-2 uppercase">
                  GLOBAL WAGER ARENA
                </span>
              </div>
            </ParticleCard>

            <ParticleCard
              onClick={() => {
                resetGame();
                setMode("local_coop");
              }}
              className="magic-bento-card magic-bento-card--border-glow px-4 py-6 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer hover:border-[#00FFD1]"
            >
              <Users className="w-8 h-8 text-zinc-400 group-hover:rotate-12 transition-transform group-hover:text-[#00FFD1]" />
              <div className="text-center">
                <span className="block font-black text-lg md:text-xl uppercase tracking-tighter italic leading-none">
                  Local Co-Op
                </span>
                <span className="block text-[8px] text-white/40 font-bold tracking-widest mt-2 uppercase">
                  PASS & PLAY
                </span>
              </div>
            </ParticleCard>

            <ParticleCard
              onClick={() => setMode("practice_wager")}
              className="magic-bento-card magic-bento-card--border-glow px-4 py-6 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer hover:border-[#00FFD1]"
            >
              <Cpu className="w-8 h-8 text-zinc-400 group-hover:rotate-12 transition-transform group-hover:text-[#00FFD1]" />
              <div className="text-center">
                <span className="block font-black text-lg md:text-xl uppercase tracking-tighter italic leading-none">
                  Practice
                </span>
                <span className="block text-[8px] text-white/40 font-bold tracking-widest mt-2 uppercase">
                  SELF-WAGER TRAINING
                </span>
              </div>
            </ParticleCard>
          </div>

          {/* Practice difficulty — applies to the Practice (Computer) match */}
          <div className="w-full max-w-xl mx-auto px-6 py-5 rounded-2xl border border-[#00FFD1]/25 bg-[#041010]/80">
            <DifficultySelector
              tiers={CONNECT_DIFFICULTIES}
              value={aiDifficulty}
              onChange={setAiDifficulty}
              title="Practice Difficulty"
              caption={connectDifficultyCaption(aiDifficulty)}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-12">
            <ParticleCard className="magic-bento-card magic-bento-card--border-glow backdrop-blur-md p-5 rounded-xl border flex flex-col items-center gap-2 transition-all cursor-default border-[#00FFD1]/40">
              <div className="material-symbols-outlined text-[#00FFD1] text-2xl">
                videogame_asset
              </div>
              <p className="text-[10px] font-mono tracking-widest uppercase text-[#B1C5FF]/70">
                Practice
              </p>
            </ParticleCard>
            <ParticleCard className="magic-bento-card magic-bento-card--border-glow backdrop-blur-md p-5 rounded-xl border flex flex-col items-center gap-2 transition-all cursor-default border-[#00FFD1]/40">
              <div className="material-symbols-outlined text-[#00FFD1] text-2xl">
                smart_toy
              </div>
              <p className="text-[10px] font-mono tracking-widest uppercase text-[#B1C5FF]/70">
                Online
              </p>
            </ParticleCard>
            <ParticleCard className="magic-bento-card magic-bento-card--border-glow backdrop-blur-md p-5 rounded-xl border flex flex-col items-center gap-2 transition-all cursor-default border-[#00FFD1]/40">
              <div className="material-symbols-outlined text-[#00FFD1] text-2xl">
                trending_up
              </div>
              <p className="text-[10px] font-mono tracking-widest uppercase text-[#B1C5FF]/70">
                Wager
              </p>
            </ParticleCard>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-[#081616] overflow-hidden">
      <style>{`
        @keyframes drop {
          from { transform: translateY(-${ROWS * 80}px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .neon-glow { box-shadow: 0 0 30px rgba(0, 255, 209, 0.15); }
        .neon-text-glow { text-shadow: 0 0 10px rgba(0, 255, 209, 0.6); }
        .grid-glow { box-shadow: 0 0 20px rgba(0, 255, 209, 0.2), inset 0 0 20px rgba(0, 255, 209, 0.2); }
        .piece-cyan { 
            background: linear-gradient(135deg, #00FFD1, #00e0b7);
            box-shadow: 0 0 15px rgba(0, 255, 209, 0.8), inset 0 0 10px rgba(255, 255, 253, 0.5); 
        }
        .piece-dark { 
            background: #1a1c1c;
            box-shadow: 0 0 10px rgba(0, 255, 209, 0.4); 
            border: 2px solid #00FFD1;
        }
        .glass-panel { backdrop-filter: blur(20px); background: rgba(42, 55, 55, 0.6); }
      `}</style>

      {/* Permanent Left Sidebar (Nav & Actions) */}
      <ConnectNavSidebar 
        gameTitle="Neon Connect"
        onReturn={() => { resetGame(); setMode("lobby"); }}
        onExit={onExit}
        gameMode={mode}
        onPlayOnline={() => { resetGame(); setMode("online"); }}
        onPlayComputer={() => { resetGame(); setMode("local"); }}
        onPlayLocal={() => { resetGame(); setMode("local_coop"); }}
        profile={profile}
      />

      <div className="flex-1 overflow-y-auto h-screen relative">
        <div className="flex justify-center items-center py-10 min-h-full gap-8 max-w-[1200px] mx-auto">
          {/* Game Selection */}
          <div className="w-[280px] h-[652px] flex-shrink-0 mt-[40px]">
             <GameMenuPanel 
               onReturn={() => { resetGame(); setMode("lobby"); }}
               onExit={onExit}
               gameMode={mode}
               onPlayOnline={() => { resetGame(); setMode("online"); }}
               onPlayComputer={() => { resetGame(); setMode("practice_wager"); }} // Practice in Connect
               onPlayLocal={() => { resetGame(); setMode("local_coop"); }}
               profile={profile}
             />
          </div>

          {/* Game Board Area */}
          <div className="flex-none flex flex-col items-center justify-center min-h-0 mt-[40px]">
            <div className="w-fit flex flex-col relative">
              <div className="absolute -top-12 right-2 flex items-center justify-end w-full">
                <div className="flex items-center gap-4">
                  <div
                    className={`px-4 py-1.5 rounded-full border border-[#00FFD1]/30 bg-[#00FFD1]/5 text-[#00FFD1] text-[10px] font-mono tracking-widest uppercase animate-pulse`}
                  >
                    {gameStatus === "playing"
                    ? mode === "online"
                      ? myTurn
                        ? "YOUR TURN"
                        : "WAITING..."
                      : `PLAYER ${currentPlayer} TURN`
                    : "GAME OVER"}
                </div>
              </div>
            </div>

            <div className="relative bg-black/40 rounded-3xl p-6 md:p-8 border-2 border-[#00FFD1]/30 shadow-[0_0_50px_rgba(0,255,209,0.1),inset_0_0_30px_rgba(0,255,209,0.05)]">
              {/* Visual Grid */}
              <div className="grid grid-cols-7 gap-3 md:gap-4 p-4 rounded-2xl relative">
                {/* Ghost Header (Indicators) */}
                {Array.from({ length: COLS }).map((_, col) => (
                  <div
                    key={`ind-${col}`}
                    className="flex justify-center h-12 md:h-16 mb-2"
                  >
                    <div
                      className={`w-3 h-3 rounded-full transition-all duration-300 ${animatingColumn === col ? "bg-[#00FFD1] scale-150" : "bg-[#00FFD1]/20"}`}
                    />
                  </div>
                ))}

                {/* Board Slots */}
                {Array.from({ length: ROWS }).map((_, row) =>
                  Array.from({ length: COLS }).map((_, col) => {
                    const index = row * COLS + col;
                    const piece = board[index];
                    return (
                      <div
                        key={`cell-${row}-${col}`}
                        className="w-12 h-12 md:w-16 md:h-16 rounded-full border-2 border-white/5 bg-black/20 shadow-[inset_0_0_15px_rgba(0,255,209,0.03)] flex items-center justify-center overflow-hidden"
                      >
                        <AnimatePresence>
                          {piece !== EMPTY && (
                            <motion.div
                              initial={{ y: -400 }}
                              animate={{ y: 0 }}
                              exit={{ opacity: 0 }}
                              transition={{
                                type: "spring",
                                damping: 18,
                                stiffness: 120,
                              }}
                              className={`w-10 h-10 md:w-12 md:h-12 rounded-full ${piece === HUMAN ? "piece-cyan" : "piece-dark"}`}
                            />
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  }),
                )}

                {/* Interaction Overlay (The Clickable Columns) */}
                <div className="absolute inset-0 grid grid-cols-7 gap-3 md:gap-4 p-4 pointer-events-none">
                  {Array.from({ length: COLS }).map((_, col) => (
                    <button
                      key={`col-btn-${col}`}
                      onClick={() => handleColumnClick(col)}
                      disabled={
                        !canPlay ||
                        gameStatus !== "playing" ||
                        animatingColumn !== null ||
                        (mode === "online" && !myTurn)
                      }
                      className="h-full w-full pointer-events-auto cursor-pointer hover:bg-[#00FFD1]/5 transition-colors rounded-xl border border-transparent hover:border-[#00FFD1]/10"
                    />
                  ))}
                </div>

                {/* Game Over Overlay inside the visual grid */}
                <AnimatePresence>
                  {gameStatus !== "playing" && (
                    <ResultsScreen 
                      won={gameStatus === "won" && (mode === "online" ? winner === myPlayerId : winner === HUMAN)}
                      stake={mode === "local" ? wagerAmount : 0}
                      winnings={
                        mode === "local" 
                          ? (gameStatus === "won" && winner === HUMAN ? wagerAmount * 2 : (gameStatus === "draw" ? wagerAmount : 0)) 
                          : 0
                      }
                      gameMode={mode === "local" ? "Practice" : (mode === "online" ? "Online" : "Local")}
                      onRematch={resetGame}
                      onExit={() => {
                        resetGame();
                        setMode("lobby");
                      }}
                    />
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>

        {/* Right Side Panel */}
        <div style={{ width: 300, height: 652, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }} className="mt-[40px]">
          {mode === 'local' && (
            <div style={{ background: '#041010', border: '1px solid rgba(0,255,209,0.2)', borderRadius: 8, padding: '12px 10px', flexShrink: 0 }}>
              <DifficultySelector
                tiers={CONNECT_DIFFICULTIES}
                value={aiDifficulty}
                onChange={setAiDifficulty}
                title="AI Difficulty"
                caption={connectDifficultyCaption(aiDifficulty)}
                compact
                disabled={currentPlayer === OPPONENT && gameStatus === 'playing'}
              />
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0 }}>
            <ConnectHistoryPanel
              history={moveHistory}
              onUndo={(mode === 'local' || mode === 'local_coop') ? handleUndo : undefined}
              onNewGame={resetGame}
            />
          </div>
        </div>
      </div></div>
    </div>
  );
};

export default NeonConnectGame;
