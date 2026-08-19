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
  Swords,
  Plus } from 'lucide-react';
import GameBackButton from '../common/GameBackButton';
// The real arcade menu column (rank card, drawer deep-links, live friends) —
// replaces the old static ConnectNavSidebar mock-up.
import { GameNavSidebar } from '../common/GameNavSidebar';
import { LobbyLevelStrip } from '../common/LobbyLevelStrip';
import PrivateWagerRoom from "../social/PrivateWagerRoom";
import { usePrivateWagerStarted } from "../social/PrivateWagerInvite";
// Shared authed game socket — connects lazily when entering online mode,
// never at import (the old per-effect bare io() reconnected on every
// myPlayerId/gameStatus change and re-queued freshly-matched players).
import { connectGameSocket, getSocket, useMatchProgression } from "../../hooks/useGameSocket";
import { PostGameProgression } from "../common/PostGameProgression";
// The one matchmaking screen every online game shows while queued.
import { SearchingForMatch } from "../common/SearchingForMatch";
import { LibraryBlob } from "../glass/LibraryBlob";
import { WagerMenu } from "../NeonBucks/WagerMenu";
import { ResultsScreen } from "../NeonBucks/ResultsScreen";
import { useNeonBucks } from "../../NeonBucksStore";
import { ParticleCard, GlobalSpotlight } from "../glass/MagicGameTile";
import { DifficultySelector } from "../common/DifficultySelector";
import LobbyModeTiles from "../common/LobbyModeTiles";
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
          {/* NO WAGER ONLINE: this used to read "Wager Match". Online play has
              no stake of any kind — the click goes straight to matchmaking. */}
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
  const [onlineOpponent, setOnlineOpponent] = useState<string | null>(null);
  // One-line story under the results verdict ("opponent left — forfeit win").
  const [endNote, setEndNote] = useState<string | null>(null);
  // The server's per-player "+XP / rank change" event, chained after the
  // results screen as the level/rank progression overlays.
  const { progression, clear: clearProgression } = useMatchProgression();
  // OPTIMISTIC MATCHMAKING FLAG. Set the instant an online mode is CLICKED —
  // never from a server ack — so a dropped/absent reply can't leave the player
  // staring at a dead board. Cleared only by `neonconnect_match` (or cancel).
  const [searching, setSearching] = useState(false);
  // Bumped on every online entry. It is part of the socket effect's deps so
  // that re-entering online play FROM online play (clicking Online Match in
  // the sidebar after a finished game, where `mode` never changes) still
  // tears the old game down and sends a fresh `neonconnect_join` — otherwise
  // the searching screen would sit on a queue we never actually joined.
  const [searchNonce, setSearchNonce] = useState(0);
  // PRIVATE WAGER: invite-only 1v1 against a friend. Its card REPLACED the old
  // LOCAL CO-OP card in the lobby grid (design contract); pass & play itself is
  // untouched and still reachable from the link under the grid.
  const [showPrivateWager, setShowPrivateWager] = useState(false);
  const [myTurn, setMyTurn] = useState<boolean>(true);
  // Live queue occupancy from the server's `queue:status`, shown on the
  // SEARCHING screen. The design contract asks for `PLAYERS: n / N` wherever
  // the server reports a count — Connect emits one on every join/leave, it
  // just was not being read.
  const [queueCount, setQueueCount] = useState<{
    current: number;
    needed: number;
  } | null>(null);
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

  // Singleton — stable across renders, NOT connected until connectGameSocket().
  const socket = getSocket();

  // Refs mirroring mutable state the socket handlers read. The online effect
  // binds its listeners ONCE (keyed only on mode) — reading state directly in
  // the handlers would be stale, and putting the state in the effect deps was
  // the old reconnect-churn bug (matched player-2 instantly re-queued).
  const myPlayerIdRef = useRef(myPlayerId);
  const gameStatusRef = useRef(gameStatus);
  const winnerRef = useRef(winner);
  const matchedRef = useRef(false); // paired into a game this online session?
  const profileRef = useRef(profile);

  useEffect(() => {
    if (onGameStatusChange) {
      onGameStatusChange(mode !== "lobby");
    }
  }, [mode, onGameStatusChange]);

  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  useEffect(() => {
    myPlayerIdRef.current = myPlayerId;
  }, [myPlayerId]);

  useEffect(() => {
    gameStatusRef.current = gameStatus;
  }, [gameStatus]);

  useEffect(() => {
    winnerRef.current = winner;
  }, [winner]);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

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
    // mode/wagerAmount/win were missing here — the stale closure kept `mode`
    // frozen at 'lobby', so practice payouts never fired and the online socket
    // handlers would apply moves with lobby-era rules.
    [getAvailableRow, checkWin, isBoardFull, mode, wagerAmount, win],
  );

  // Fresh executeMove for the once-bound socket handlers (see refs above).
  const executeMoveRef = useRef(executeMove);
  useEffect(() => {
    executeMoveRef.current = executeMove;
  }, [executeMove]);

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

  // ==================== Reset helpers ====================

  // Clears ALL local board state. `firstPlayer` = who moves first (connect
  // player ids are absolute: 1 or 2, not relative to this client).
  const applyLocalReset = useCallback((firstPlayer: number = HUMAN) => {
    setBoard(Array(ROWS * COLS).fill(EMPTY));
    setCurrentPlayer(firstPlayer);
    setGameStatus("playing");
    setWinner(null);
    setMoveHistory([]);
    setAnimatingColumn(null);
    setCanPlay(true);
    setEndNote(null);
    // A rematch inside the progression overlay's 1.4s lead-in must not let
    // the LAST round's "+XP / RANKED UP" play over a fresh board.
    clearProgression();
  }, [clearProgression]);

  // "New Game" — online it is a two-sided rematch handshake: we only ASK the
  // server; the board clears when the room-broadcast neonconnect_reset lands
  // (see onRoomReset below). Local modes reset immediately.
  const resetGame = () => {
    if (mode === "online") {
      socket.emit("neonconnect_reset");
      return;
    }
    applyLocalReset();
  };

  // ==================== Online entry / exit ====================

  // The ONE way into online play. There is NO wager, stake or entry fee: the
  // click goes straight to matchmaking and the SEARCHING FOR ONLINE MATCH
  // screen renders on this very render pass (optimistic — see `searching`).
  const enterOnlineMatchmaking = useCallback(() => {
    applyLocalReset();
    setOnlineOpponent(null);
    setMyTurn(false); // nothing is playable until the server seats us
    setSearching(true);
    setSearchNonce((n) => n + 1); // force a fresh join even if already online
    setMode("online");
  }, [applyLocalReset]);

  /**
   * A private match started from a room this component did NOT open — the
   * invitee accepted from the nav-bar bell, a pop-up, or a friend's row, and
   * the app navigated here so this component would be mounted and listening.
   * Neon Connect only mounts its online screen on demand, so this is the same
   * handoff `onStarted` performs for the room the lobby opens itself.
   */
  usePrivateWagerStarted("connect", () => {
    enterOnlineMatchmaking();
  });

  // Cancel while queued. Emitting here (as well as in the effect cleanup that
  // fires on the mode change) guarantees the server frees our slot even if the
  // unmount path is ever short-circuited — leaveConnectQueue is idempotent.
  const cancelOnlineSearch = useCallback(() => {
    socket.emit("leaveConnectQueue");
    setSearching(false);
    applyLocalReset();
    setMode("lobby");
  }, [socket, applyLocalReset]);

  // ==================== Socket.io Integration ====================

  // Keyed ONLY on mode==='online' — mutable state (myPlayerId, gameStatus,
  // winner) is read via refs inside the handlers. The old deps list tore the
  // socket down and re-queued the player whenever a match assigned playerId 2
  // or the game ended.
  useEffect(() => {
    if (mode !== "online") return;

    // Lazy connect the shared authed socket (no-op when already connected).
    const s = connectGameSocket();
    matchedRef.current = false;
    // Until the server pairs us the board must not be playable (myTurn
    // defaults to true for local modes).
    setMyTurn(false);
    setOnlineOpponent(null);
    // Belt and braces: the click handler already flipped this on, but any
    // other route into online mode must show the queue screen too.
    setSearching(true);

    s.emit("neonconnect_join", { profile: profileRef.current });

    const onMatch = (data: { opponent: string; turn: boolean; playerId: number }) => {
      matchedRef.current = true;
      setSearching(false); // paired — swap the queue screen for the board
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
    };

    const onOpponentMove = (data: { col: number }) => {
      const { col } = data;
      setAnimatingColumn(col);
      const opponentId = myPlayerIdRef.current === HUMAN ? OPPONENT : HUMAN;
      setTimeout(() => {
        const result = executeMoveRef.current(col, opponentId);
        if (result) {
          if (
            gameStatusRef.current === "playing" &&
            !("won" in result) &&
            !("draw" in result)
          ) {
            setMyTurn(true);
            setCurrentPlayer(myPlayerIdRef.current);
          }
        }
        setAnimatingColumn(null);
      }, 600);
    };

    // Server-declared result (board is authoritative server-side and ELO is
    // settled there). Local move handling usually detects the same outcome a
    // beat earlier — re-setting identical state is harmless — but this event
    // is the authority, and the only signal for server-only endings.
    const onEnded = (data: { winner: 1 | 2 | "draw"; reason?: string }) => {
      if (data.winner === "draw") {
        setGameStatus("draw");
        setWinner(null);
      } else {
        setGameStatus("won");
        setWinner(data.winner);
      }
      setCanPlay(false);
      // Forfeit endings carry the story onto the results screen: the
      // opponent walked (or dropped) and the win was awarded server-side.
      if (data.reason === "forfeit") {
        setEndNote("Your opponent left the game — you win by forfeit");
      }
    };

    // Room-broadcast rematch: BOTH players requested a reset — clear the
    // board whether or not WE were the one who clicked New Game.
    const onRoomReset = (data?: { firstPlayer?: number }) => {
      // First mover per server rule: loser of the previous game, player 2
      // after a draw. Derive locally; prefer an explicit server field if the
      // payload carries one.
      const derived =
        winnerRef.current === HUMAN
          ? OPPONENT
          : winnerRef.current === OPPONENT
            ? HUMAN
            : OPPONENT; // draw (or unknown) → previous player 2 moves first
      const first =
        typeof data?.firstPlayer === "number" ? data.firstPlayer : derived;
      applyLocalReset(first);
      setMyTurn(myPlayerIdRef.current === first);
    };

    // The shared queue acknowledgement. Connect's server sends this on every
    // join AND every leave (duplicates included), so it is also how we learn
    // a re-queue actually took. Guarded on `game` because the socket is
    // shared with every other game's queue.
    const onQueueStatus = (data: {
      game?: string;
      inQueue?: boolean;
      current?: number;
      needed?: number;
    }) => {
      if (data?.game !== "connect") return;
      if (!data.inQueue) {
        setQueueCount(null);
        return;
      }
      setQueueCount({
        current: typeof data.current === "number" ? data.current : 1,
        needed: typeof data.needed === "number" ? data.needed : 2,
      });
    };

    const onOpponentQuit = () => {
      setGameStatus("won");
      setWinner(myPlayerIdRef.current);
      setCanPlay(false);
      setOnlineOpponent((prev) => (prev ? `${prev} (DISCONNECTED)` : null));
      // Belt-and-braces beside the neonconnect_ended('forfeit') the server
      // now also sends — whichever lands first tells the same story.
      setEndNote("Your opponent left the game — you win by forfeit");
    };

    const onGameAuthError = (data: any) => {
      // Server refused matchmaking (e.g. account setup unfinished).
      console.warn("[connect] cannot play online:", data?.message ?? data?.code);
      setSearching(false);
      setMode("lobby");
    };

    const onConnectError = (err: Error) => {
      if (err.message === "unauthorized" || err.message === "auth_unavailable") {
        console.warn("[connect] socket auth failed:", err.message);
        if (!matchedRef.current) {
          setSearching(false);
          setMode("lobby");
        }
      }
    };

    s.on("queue:status", onQueueStatus);
    s.on("neonconnect_match", onMatch);
    s.on("neonconnect_opponent_move", onOpponentMove);
    s.on("neonconnect_ended", onEnded);
    s.on("neonconnect_reset", onRoomReset);
    s.on("neonconnect_opponent_quit", onOpponentQuit);
    s.on("gameAuthError", onGameAuthError);
    s.on("connect_error", onConnectError);

    return () => {
      // Still queued (never matched)? Free the server-side queue slot.
      // Matched? Tell the server we walked away — the shared singleton stays
      // CONNECTED, so without this a mid-game UI exit would strand the
      // opponent until our tab closed (active game = forfeit server-side).
      if (!matchedRef.current) s.emit("leaveConnectQueue");
      else s.emit("neonconnect_leave");
      s.off("queue:status", onQueueStatus);
      s.off("neonconnect_match", onMatch);
      s.off("neonconnect_opponent_move", onOpponentMove);
      s.off("neonconnect_ended", onEnded);
      s.off("neonconnect_reset", onRoomReset);
      s.off("neonconnect_opponent_quit", onOpponentQuit);
      s.off("gameAuthError", onGameAuthError);
      s.off("connect_error", onConnectError);
    };
    // searchNonce: re-entering online from online must re-queue (see above).
  }, [mode, applyLocalReset, searchNonce]);

  if (mode === "lobby" || mode === "practice_wager") {
    return (
      // Scrollable, top-aligned on phones. `justify-center` inside an
    // `overflow-hidden` box taller than the viewport put the top of the
    // lobby ABOVE the visible area with no way to scroll to it — the mode
    // cards were simply unreachable on a phone.
    <div className="min-h-[100dvh] max-h-[100dvh] bg-[#081616] flex flex-col items-center justify-start md:justify-center px-4 py-24 md:p-6 relative overflow-y-auto overflow-x-hidden">
        <GameBackButton onClick={onExit} title="Back to arcade" positionClassName="absolute top-6 left-6 z-50" />
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

          {/* Level progression — compact strip under the title. */}
          <LobbyLevelStrip />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full text-left">
            {/* ONLINE ENTRY — no wager, no stake, no browser dialogs.
                This card used to open a wager-amount input followed by a
                "not implemented" alert, so online play could never even
                start. It now goes straight to matchmaking. */}
            <ParticleCard
              onClick={enterOnlineMatchmaking}
              className="magic-bento-card magic-bento-card--border-glow px-4 py-6 bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] rounded-2xl hover:shadow-[0_0_50px_rgba(0,255,209,0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
            >
              <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>
              <Globe className="w-8 h-8 group-hover:rotate-12 transition-transform" />
              <div className="text-center">
                <span className="block font-black text-lg md:text-xl uppercase tracking-tighter italic leading-none">
                  Wager Match
                </span>
                <span className="block text-[8px] opacity-60 font-bold tracking-widest mt-2 uppercase">
                  GLOBAL WAGER ARENA
                </span>
              </div>
            </ParticleCard>

            {/* PRIVATE WAGER — replaces the old LOCAL CO-OP card (design
                contract). Invite an online friend, both press READY, 3-2-1,
                and the normal online Connect match starts between the two of
                you. Free: "wager" is a name, nothing is staked. */}
            <ParticleCard
              onClick={() => setShowPrivateWager(true)}
              className="magic-bento-card magic-bento-card--border-glow px-4 py-6 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer hover:border-[#00FFD1]"
            >
              <Swords className="w-8 h-8 text-zinc-400 group-hover:rotate-12 transition-transform group-hover:text-[#00FFD1]" />
              <div className="text-center">
                <span className="block font-black text-lg md:text-xl uppercase tracking-tighter italic leading-none">
                  Private Wager
                </span>
                <span className="block text-[8px] text-white/40 font-bold tracking-widest mt-2 uppercase">
                  INVITE A FRIEND
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

          {/* LOCAL CO-OP kept reachable. The contract replaced its CARD with
              Private Wager, but pass & play itself must keep working exactly
              as today — so it lives on as this secondary link. Delete this
              block if the mode should disappear from the UI entirely. */}
          <button
            type="button"
            onClick={() => {
              applyLocalReset();
              setMode("local_coop");
            }}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-full border border-[#00FFD1]/25 text-[9px] font-mono font-bold uppercase tracking-[0.25em] text-[#B1C5FF]/50 hover:text-[#B1C5FF] hover:border-[#00FFD1]/60 transition-all cursor-pointer"
          >
            <Users className="w-3.5 h-3.5" />
            Local Co-Op · Pass &amp; Play
          </button>

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

          {/* Shared lobby footer — see common/LobbyModeTiles. */}
          <LobbyModeTiles />
        </div>

        {/* Private-wager waiting room.
            Connect's socket listeners are keyed on `mode === "online"`, so
            they are NOT mounted while the lobby is showing. When the server
            starts the private match we therefore hand off through the SAME
            entry point the WAGER MATCH card uses — that mounts the online
            screen and its `neonconnect_match` listener. */}
        {showPrivateWager && (
          <PrivateWagerRoom
            gameKey="connect"
            mode="1v1"
            onClose={() => setShowPrivateWager(false)}
            onStarted={enterOnlineMatchmaking}
          />
        )}
      </div>
    );
  }

  // ==================== ONLINE MATCHMAKING SCREEN ====================
  // Rendered from the moment the player clicks an online mode until the server
  // seats them (`neonconnect_match`). It does NOT wait for any ack to appear —
  // that dependency was the "refuses to search" bug. Same component, same copy
  // as every other online game.
  if (mode === "online" && searching) {
    return (
      // Scrollable, top-aligned on phones. `justify-center` inside an
    // `overflow-hidden` box taller than the viewport put the top of the
    // lobby ABOVE the visible area with no way to scroll to it — the mode
    // cards were simply unreachable on a phone.
    <div className="min-h-[100dvh] max-h-[100dvh] bg-[#081616] flex flex-col items-center justify-start md:justify-center px-4 py-24 md:p-6 relative overflow-y-auto overflow-x-hidden">
        <GameBackButton
          onClick={cancelOnlineSearch}
          title="Back to lobby"
          positionClassName="absolute top-6 left-6 z-50"
        />

        {/* Same ambient glow as the lobby so the transition feels continuous. */}
        <div className="absolute inset-0 opacity-20 pointer-events-none">
          <div className="absolute top-20 left-20 w-96 h-96 bg-[#00FFD1] rounded-full blur-[120px] opacity-20 animate-pulse" />
          <div
            className="absolute bottom-20 right-20 w-96 h-96 bg-[#FF0080] rounded-full blur-[120px] opacity-20 animate-pulse"
            style={{ animationDelay: "1s" }}
          />
        </div>

        <div className="relative z-10 w-full max-w-2xl">
          {/* 1v1: no playersNeeded → the PLAYERS n/N counter stays hidden. */}
          <SearchingForMatch
            playersInQueue={queueCount?.current}
            playersNeeded={queueCount?.needed}
            onCancel={cancelOnlineSearch}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex flex-col lg:flex-row bg-[#081616] overflow-hidden">
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

      {/* Permanent Left Sidebar — the REAL arcade menu (rank, friends,
          deep-links into the drawer), not the old static mock-up. */}
      <GameNavSidebar gameTitle="Neon Connect" />

      <div className="flex-1 overflow-y-auto h-[100dvh] relative">
        {/* STACKED below lg. The side panel is a fixed 280px and the board is
            ~310px at phone width — side by side they need 620px+, so the
            board was simply cut off. Board first (order-1), menu after it. */}
        <div className="flex flex-col lg:flex-row justify-start lg:justify-center items-center py-6 lg:py-10 min-h-full gap-6 lg:gap-8 max-w-[1200px] mx-auto px-3 lg:px-0">
          {/* Game Selection */}
          <div className="order-2 lg:order-1 w-full max-w-[340px] lg:w-[280px] h-auto lg:h-[652px] flex-shrink-0 mt-0 lg:mt-[40px]">
             <GameMenuPanel
               onReturn={() => { applyLocalReset(); setMode("lobby"); }}
               onExit={onExit}
               gameMode={mode}
               onPlayOnline={enterOnlineMatchmaking}
               onPlayComputer={() => { applyLocalReset(); setMode("practice_wager"); }} // Practice in Connect
               onPlayLocal={() => { applyLocalReset(); setMode("local_coop"); }}
               profile={profile}
             />
          </div>

          {/* Game Board Area */}
          <div className="order-1 lg:order-2 flex-none flex flex-col items-center justify-center min-h-0 mt-14 lg:mt-[40px]">
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

            <div className="relative bg-black/40 rounded-2xl sm:rounded-3xl p-2 sm:p-6 md:p-8 border-2 border-[#00FFD1]/30 shadow-[0_0_50px_rgba(0,255,209,0.1),inset_0_0_30px_rgba(0,255,209,0.05)]">
              {/* Visual Grid */}
              <div className="grid grid-cols-7 gap-1.5 xs:gap-2 sm:gap-3 md:gap-4 p-1.5 xs:p-2 sm:p-4 rounded-2xl relative touch-manipulation">
                {/* Ghost Header (Indicators) */}
                {Array.from({ length: COLS }).map((_, col) => (
                  <div
                    key={`ind-${col}`}
                    className="flex justify-center h-9 xs:h-11 sm:h-12 md:h-16 mb-1 sm:mb-2"
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
                        className="w-9 h-9 xs:w-11 xs:h-11 sm:w-12 sm:h-12 md:w-16 md:h-16 rounded-full border-2 border-white/5 bg-black/20 shadow-[inset_0_0_15px_rgba(0,255,209,0.03)] flex items-center justify-center overflow-hidden"
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
                              className={`w-7 h-7 xs:w-9 xs:h-9 sm:w-10 sm:h-10 md:w-12 md:h-12 rounded-full ${piece === HUMAN ? "piece-cyan" : "piece-dark"}`}
                            />
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  }),
                )}

                {/* Interaction Overlay (The Clickable Columns) */}
                <div className="absolute inset-0 grid grid-cols-7 gap-1.5 xs:gap-2 sm:gap-3 md:gap-4 p-1.5 xs:p-2 sm:p-4 pointer-events-none">
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
                      // Online stakes nothing — hide the Wagered/Payout rows.
                      moneyless={mode === "online"}
                      note={mode === "online" ? endNote : null}
                      onRematch={resetGame}
                      onExit={() => {
                        applyLocalReset();
                        setMode("lobby");
                      }}
                    />
                  )}
                </AnimatePresence>

                {/* Level/rank progression, chained after the results screen.
                    Renders nothing until the server's match:progression
                    event lands (a beat after neonconnect_ended). */}
                <PostGameProgression progression={progression} onDone={clearProgression} />
              </div>
            </div>
          </div>
        </div>

        {/* Right Side Panel — move history. `order-3` is load-bearing: its
            siblings carry explicit orders (menu order-2 lg:order-1, board
            order-1 lg:order-2), so without one this panel defaulted to
            order 0 and sorted to the far LEFT on desktop and to the TOP on
            mobile. order-3 places it to the RIGHT of the board on desktop
            and after the menu in the mobile stack. */}
        <div style={{ width: 300, height: 652, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }} className="order-3 mt-[40px]">
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
