import React, { useState, useEffect, useRef } from 'react';
import { Globe, Cpu, LogOut, Swords } from 'lucide-react';
import { ParticleCard } from '../glass/MagicGameTile';
// The real arcade menu column (rank card, drawer deep-links, live friends) —
// replaces the old static ChessNavSidebar mock-up.
import { GameNavSidebar } from '../common/GameNavSidebar';
// Private-wager waiting room, openable from the in-game side panel.
import PrivateWagerRoom from '../social/PrivateWagerRoom';
import { GamePauseMenu } from '../common/GamePauseMenu';
import { PerfHud } from '../common/PerfHud';
// Shared matchmaking screen — identical copy/look in every online game.
import SearchingForMatch from '../common/SearchingForMatch';
import GameLobby from './GameLobby';
import ComputerGame from './ComputerGame';
import OnlineGame from './OnlineGame';
import LocalGame from './LocalGame';
import { useComputerMove } from './useComputerMove';
import { DEFAULT_SKILL_LEVEL } from './difficulty';
// Shared authed game socket — connects lazily when the player enters online
// mode (connectGameSocket), never at module import.
import { connectGameSocket, getSocket, useMatchProgression } from '../../hooks/useGameSocket';
// Level/rank progression overlays, chained after the game-over overlay.
import { PostGameProgression } from '../common/PostGameProgression';
// "Are you sure? leaving forfeits" — every mid-match exit (pause menu, side
// panel, mode cards, App nav bar) funnels through this guard.
import { useGuardedExit } from '../common/exitGuard';

interface ChessGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inProgress: boolean) => void;
}

/** Server-declared end of an online game (resign / disconnect / mate / draw). */
export interface ServerGameEnd {
  winner: 'white' | 'black' | 'draw';
  reason: string;
}


function GameMenuPanel({ 
  onReturn, 
  onExit,
  gameMode, 
  onPlayOnline, 
  onPlayComputer, 
  onPrivateWager,
  profile
}: { 
  onReturn: () => void, 
  onExit: () => void,
  gameMode: string | null,
  onPlayOnline: () => void,
  onPlayComputer: () => void,
  onPrivateWager: () => void,
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
            <span className="block font-black text-[10px] uppercase tracking-tighter italic leading-none">Wager Match</span>
          </div>
        </ParticleCard>

        {/* Private Wager — invite a friend into an invite-only online match.
            Replaces the old Local Co-Op card (pass-and-play still lives in
            the lobby); ordered per design: Wager top, Private middle,
            Practice bottom. */}
        <ParticleCard
          onClick={onPrivateWager}
          className="magic-bento-card flex-1 px-3 py-3.5 rounded-xl transition-all duration-300 flex flex-col items-center justify-center gap-1.5 group relative overflow-hidden cursor-pointer bg-[#081616] border border-[#00FFD1]/40 text-white hover:border-[#00FFD1] hover:shadow-[0_0_20px_rgba(0,255,209,0.2)]"
          style={{ backdropFilter: 'none' }}
        >
          <Swords className="w-5 h-5 shrink-0 text-zinc-400 group-hover:rotate-12 transition-transform block" />
          <div className="text-center">
            <span className="block font-black text-[10px] uppercase tracking-tighter italic leading-none">
              Private Wager
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

// PRACTICE-ONLY: the Neon Bucks wager menu is shown before a COMPUTER game.
// The online path never stakes anything — no SOL, no Neon Bucks.
import { WagerMenu } from '../NeonBucks/WagerMenu';

export default function ChessGame({ onExit, profile, onGameStatusChange }: ChessGameProps) {
  const [gameState, setGameState] = useState<'lobby' | 'waiting' | 'playing' | 'ended' | 'practice_wager'>('lobby');
  // Private-wager room opened from the side panel (the lobby screen has its
  // own copy inside GameLobby; the two never render together).
  const [showPrivateWager, setShowPrivateWager] = useState(false);
  // Per-player "+XP / rank change" from the server, chained after the
  // GameOverOverlay (arrives with the gameEnded settle, online only).
  const { progression, clear: clearProgression } = useMatchProgression();
  const [playerData, setPlayerData] = useState<any>(null);
  const [gameData, setGameData] = useState<any>(null);
  const [gameMode, setGameMode] = useState<'multiplayer' | 'computer' | 'local' | null>(null);
  const [wagerAmount, setWagerAmount] = useState<number>(0);
  // Practice-mode engine strength (Stockfish skill level), shared by the
  // lobby selector and the in-game selector.
  const [skillLevel, setSkillLevel] = useState<number>(DEFAULT_SKILL_LEVEL);

  const [externalMove, setExternalMove] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'waiting' | 'disconnected'>('disconnected');
  // Result pushed by the server (resign / disconnect / reported mate / draw).
  // Rendered by OnlineGame's end overlay — local chess.js detection alone
  // can't see the opponent resigning or dropping.
  const [serverGameEnd, setServerGameEnd] = useState<ServerGameEnd | null>(null);
  // Live queue occupancy from `queue:status`, shown while searching.
  const [queueCount, setQueueCount] = useState<{ current: number; needed: number } | null>(null);

  // Singleton — stable across renders, NOT connected until connectGameSocket().
  const socket = getSocket();

  const { getBestMove } = useComputerMove();

  // Practice round lifecycle, reported up by ComputerGame — ChessGame's own
  // gameState stays 'playing' through a practice checkmate, so without this
  // the guard would still demand a forfeit on the results screen.
  const [practiceRoundOver, setPracticeRoundOver] = useState(false);
  // Bumped to make ComputerGame end its round as a resignation loss.
  const [practiceForfeitNonce, setPracticeForfeitNonce] = useState(0);
  // Same lifecycle report for local pass-and-play (no stakes, but the
  // confirm should stop asking once the board has a result).
  const [localRoundOver, setLocalRoundOver] = useState(false);
  // And for the online board: a locally-detected mate can end the game while
  // gameState is still 'playing' (the server never hears client-side mates)
  // — leaving THAT screen must not be treated as a resignation.
  const [onlineRoundOver, setOnlineRoundOver] = useState(false);

  // A round the player would LOSE by leaving:
  //  · online: the 'playing' window until the board has a result
  //  · practice: until ComputerGame reports its round over
  //  · local: until the board has a result (leaving just ends the sitting)
  // 'waiting' is deliberately NOT forfeitable — cancelling a queue is free.
  const forfeitable =
    gameState === 'playing' &&
    ((gameMode === 'multiplayer' && !onlineRoundOver) ||
      (gameMode === 'computer' && !practiceRoundOver) ||
      (gameMode === 'local' && !localRoundOver));

  const {
    requestExit,
    finishExit,
    abortPendingExit,
    confirmDialog,
  } = useGuardedExit({
    active: forfeitable,
    onForfeit: () => {
      if (gameMode === 'multiplayer' && gameData?.gameId) {
        // The server settles the resignation and answers with gameEnded +
        // match:progression — the results overlay and the progression
        // sequence play out before the deferred navigation runs.
        socket.emit('resign', gameData.gameId);
        return 'wait';
      }
      if (gameMode === 'computer') {
        // ComputerGame ends the round as a loss: results screen, practice
        // XP report, level progression — then finishExit navigates.
        setPracticeForfeitNonce((n) => n + 1);
        return 'wait';
      }
      // Local pass-and-play: nothing staked, nothing scored — just go.
      return 'immediate';
    },
    copy: () =>
      gameMode === 'multiplayer'
        ? {
            message:
              'Leaving now resigns the match — your opponent takes the win. Your results and progression will play before you go.',
            confirmLabel: 'Resign & leave',
          }
        : gameMode === 'computer'
          ? {
              message:
                'Leaving now ends the practice match as a loss and forfeits your wager. Your results will play before you go.',
            }
          : {
              message: 'Leaving now ends the local match for both players.',
              confirmLabel: 'Leave game',
            },
  });

  // Mirrors of state for listeners/cleanups that must not re-subscribe on
  // every render (the socket handlers below are bound exactly once).
  const gameStateRef = useRef(gameState);
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);
  const findPayloadRef = useRef<{ name: string; avatarUrl: string } | null>(null);

  useEffect(() => {
    if (onGameStatusChange) {
      onGameStatusChange(gameState !== 'lobby');
    }
  }, [gameState, onGameStatusChange]);

  useEffect(() => {
    // Named handlers + handler-specific socket.off: the socket is SHARED with
    // the other games, so blanket socket.off('event') would strip their
    // listeners (and the global connect_error logger) too.
    const onConnect = () => {
      setConnectionStatus('connected');
      // A reconnect hands us a BRAND NEW socket.id, so any queue slot the
      // server still holds for the old id is stale. Re-enter the queue if we
      // are still searching — findGame is idempotent server-side.
      if (gameStateRef.current === 'waiting' && findPayloadRef.current) {
        socket.emit('findGame', findPayloadRef.current);
      }
    };
    const onDisconnect = () => setConnectionStatus('disconnected');
    const onConnectError = (err: Error) => {
      // 'unauthorized' / 'auth_unavailable' — token missing/expired or the
      // server can't verify JWTs. Surface via the existing status pill.
      if (err.message === 'unauthorized' || err.message === 'auth_unavailable') {
        console.warn('[chess] socket auth failed:', err.message);
      }
      setConnectionStatus('disconnected');
      // Never strand the player on the searching screen when the socket can't
      // even connect — there is nothing to search with.
      setGameState((s) => (s === 'waiting' ? 'lobby' : s));
    };
    // Legacy ack. The searching screen is already up (set optimistically on
    // click), so this only confirms — it must never overwrite a live game.
    const onWaiting = () => {
      setGameState((s) => (s === 'lobby' ? 'waiting' : s));
      setConnectionStatus('waiting');
    };
    // Authoritative, never-silent queue state from the shared server queue.
    const onQueueStatus = (data: any) => {
      if (data?.game !== 'chess') return; // shared socket — ignore other games
      if (data.inQueue) {
        setConnectionStatus('waiting');
        // How many are waiting with you — shown on the searching screen.
        setQueueCount({ current: data.current ?? 1, needed: data.needed ?? 2 });
        return;
      }
      // inQueue:false means "not queued AND no match started" (a started match
      // is announced by gameStart instead) — so drop the searching screen.
      setGameState((s) => (s === 'waiting' ? 'lobby' : s));
    };
    const onGameStart = (data: any) => {
      setGameState('playing');
      setGameData(data);
      setGameMode(data.mode);
      setConnectionStatus('connected');
      setServerGameEnd(null);
      setExternalMove(null);
      setOnlineRoundOver(false);
    };
    const onGameEnded = (data: any) => {
      setGameState('ended');
      setServerGameEnd({
        winner: data?.winner ?? 'draw',
        reason: data?.reason ?? 'ended',
      });
    };
    const onOpponentDisconnected = () => {
      // Informational only — the server follows up with gameEnded
      // { reason: 'disconnect' }, which drives the end overlay. (The old
      // hard reset to lobby hid the result and faked a 'Disconnected' pill.)
      console.info('[chess] opponent disconnected — awaiting server result');
    };
    const onMoveMade = (data: any) => setExternalMove(data.move);
    const onGameAuthError = (data: any) => {
      // Server refused matchmaking (e.g. account setup unfinished).
      console.warn('[chess] cannot play online:', data?.message ?? data?.code);
      setGameState('lobby');
      setConnectionStatus('disconnected');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('waiting', onWaiting);
    socket.on('queue:status', onQueueStatus);
    socket.on('gameStart', onGameStart);
    socket.on('gameEnded', onGameEnded);
    socket.on('opponentDisconnected', onOpponentDisconnected);
    socket.on('moveMade', onMoveMade);
    socket.on('gameAuthError', onGameAuthError);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('waiting', onWaiting);
      socket.off('queue:status', onQueueStatus);
      socket.off('gameStart', onGameStart);
      socket.off('gameEnded', onGameEnded);
      socket.off('opponentDisconnected', onOpponentDisconnected);
      socket.off('moveMade', onMoveMade);
      socket.off('gameAuthError', onGameAuthError);
    };
  }, [socket]);

  // Leave the queue if this whole screen goes away mid-search (route change,
  // arcade exit, hot reload). The in-app paths — Cancel, Return to lobby, Exit
  // — emit leaveQueue themselves; the server also sweeps on disconnect.
  useEffect(() => {
    return () => {
      if (gameStateRef.current === 'waiting') socket.emit('leaveQueue');
    };
  }, [socket]);

  const handleFindGame = () => {
    const fullPlayer = {
      name: profile?.name || 'Player',
      avatarUrl: profile?.avatarUrl || 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix'
    };
    setPlayerData(fullPlayer);
    findPayloadRef.current = fullPlayer;

    // OPTIMISTIC: the SEARCHING FOR ONLINE MATCH screen goes up on THIS click.
    // It is never gated on the server's ack — a dropped or absent reply used
    // to leave the UI frozen on the lobby, which is what made online look
    // broken. No wager, no stake: the online path costs nothing.
    setGameState('waiting');
    gameStateRef.current = 'waiting'; // eager: listeners/cleanup read the ref
    setConnectionStatus('connecting');
    setServerGameEnd(null);
    setExternalMove(null);

    // Lazy connect: only touches the network when entering online mode.
    const s = connectGameSocket();
    // Emits are buffered by socket.io until the connection is up.
    s.emit('findGame', fullPlayer);
    if (s.connected) setConnectionStatus('connected');

    if (!s.connected && !s.active) {
      // Not connected and not even trying (no auth token stored) — the queue
      // can never be joined, so don't spin on a screen that will never resolve.
      console.warn('[chess] game socket is not connecting — sign in to play online');
      setGameState('lobby');
      gameStateRef.current = 'lobby';
      setConnectionStatus('disconnected');
    }
  };

  const handlePlayComputer = () => {
    const fullPlayer = {
      name: profile?.name || 'Player',
      avatarUrl: profile?.avatarUrl || 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix'
    };
    setPlayerData(fullPlayer);
    setGameState('practice_wager');
  };

  /**
   * ComputerGame's round-lifecycle report, STABLE and EDGE-TRIGGERED.
   *
   * Both properties are load-bearing. An inline arrow re-fires
   * ComputerGame's report effect on identity change alone, and the render
   * that follows a confirm still has `roundOver === false` (its forfeit
   * state is only scheduled at that point) — so a level-triggered abort
   * would cancel the very exit the player just confirmed, stranding them on
   * the results screen. Only a true→false transition is a real rematch.
   */
  const practiceRoundOverRef = useRef(false);
  const handlePracticeRoundState = React.useCallback(
    (over: boolean) => {
      // The previous value comes from a ref, not a setState updater: React
      // may invoke an updater twice (StrictMode), and firing a side effect
      // from inside one is a bug waiting for a second render.
      const wasOver = practiceRoundOverRef.current;
      practiceRoundOverRef.current = over;
      setPracticeRoundOver(over);
      if (wasOver && !over) abortPendingExit(); // rematch = "I changed my mind"
    },
    [abortPendingExit]
  );

  const handlePlayLocal = () => {
    setGameMode('local');
    setLocalRoundOver(false);
    setGameState('playing');
  };

  // The resign itself now lives in the guard's onForfeit — these exits only
  // run AFTER the confirm → forfeit → results → progression flow (or right
  // away when nothing is at stake).
  const handleExitApp = () => {
    requestExit(() => {
      // Always free the queue slot on the way out — a leaked entry is what
      // yanks an absent player into a match nobody is playing.
      if (gameStateRef.current === 'waiting') {
        socket.emit('leaveQueue');
        gameStateRef.current = 'lobby'; // the unmount cleanup must not re-emit
      }
      onExit();
    });
  };

  /** The raw reset — the guarded paths run this as their continuation. */
  const resetToLobby = () => {
    if (gameStateRef.current === 'waiting') {
      socket.emit('leaveQueue');
    }
    setGameState('lobby');
    gameStateRef.current = 'lobby';
    findPayloadRef.current = null; // stop the reconnect replay
    setGameData(null);
    setGameMode(null);
    setPlayerData(null);
    setExternalMove(null);
    setServerGameEnd(null);
    setPracticeRoundOver(false);
    practiceRoundOverRef.current = false;
    setLocalRoundOver(false);
    setOnlineRoundOver(false);
  };

  // Also the Cancel button on the SEARCHING FOR ONLINE MATCH screen (where
  // the guard is inactive, so it cancels the queue instantly as before).
  const handleReturnToLobby = () => {
    requestExit(resetToLobby);
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
              setPracticeRoundOver(false);
              practiceRoundOverRef.current = false;
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
    <div className="min-h-[100dvh] flex bg-[#081616] overflow-hidden">
      {/* Permanent Left Sidebar — the REAL arcade menu (rank, friends,
          deep-links into the drawer), not the old static mock-up. */}
      <GameNavSidebar gameTitle="Neon Chess" />

      {/* Level/rank progression, chained after the game-over overlay. When a
          forfeit-exit is pending, its close is the cue to finally navigate. */}
      <PostGameProgression
        progression={progression}
        onDone={() => {
          clearProgression();
          finishExit();
        }}
      />

      {/* Mid-match "are you sure? leaving forfeits" dialog. */}
      {confirmDialog}

      {/* Pug-style pause menu — uniform across every game. Quit returns to
          the Chess lobby; the side panel's EXIT GAME still leaves to the
          arcade. Both are guarded mid-match. */}
      <GamePauseMenu onExit={handleReturnToLobby} />

      {/* FPS/ping — fixed so it survives the content pane's scroll; top-24
          keeps it clear of the floating nav (still visible during chess). */}
      {gameState !== 'waiting' && (
        <PerfHud positionClassName="fixed top-24 right-4 sm:right-6 z-40" />
      )}

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto h-[100dvh] relative">
        {gameState === 'waiting' ? (
          // Shared matchmaking screen — same copy and look in every game. The
          // PLAYERS n/N line shows how many others are queuing alongside you.
          // Cancel leaves the queue via handleReturnToLobby.
          <SearchingForMatch
            variant="page"
            playersInQueue={queueCount?.current}
            playersNeeded={queueCount?.needed}
            onCancel={handleReturnToLobby}
          />
        ) : (
          // STACKED below lg: a fixed 280px menu beside the board needs ~620px
          // of width, so on a phone the board was pushed off-screen. Board
          // first (order-1), menu below it.
          <div className="flex flex-col lg:flex-row items-center justify-start lg:justify-center py-6 lg:py-10 min-h-full gap-6 lg:gap-8 max-w-[1200px] mx-auto px-3 lg:px-0 lg:translate-y-[20px]">
            {/* The 5 buttons menu on the left */}
            <div className="order-2 lg:order-1 w-full max-w-[340px] lg:w-[280px] h-auto lg:h-[600px] flex-shrink-0">
               {/* Mode-switch cards are guarded too: picking a different mode
                   mid-match confirms, forfeits, plays the results, and only
                   then switches. */}
               <GameMenuPanel
                 onReturn={handleReturnToLobby}
                 onExit={handleExitApp}
                 gameMode={gameMode}
                 onPlayOnline={gameMode === 'multiplayer' ? () => {} : () => requestExit(handleFindGame)}
                 onPlayComputer={gameMode === 'computer' ? () => {} : () => requestExit(handlePlayComputer)}
                 onPrivateWager={() => requestExit(() => setShowPrivateWager(true))}
                 profile={profile}
               />
            </div>

            {/* Private-wager waiting room (modal overlay). ChessGame's own
                gameStart listener is mounted in every state, so the started
                private match takes over exactly like a queued one. */}
            {showPrivateWager && (
              <PrivateWagerRoom
                gameKey="chess"
                mode="1v1"
                onClose={() => setShowPrivateWager(false)}
              />
            )}

            {/* order-1: the board comes FIRST on a stacked phone layout — you
                should not have to scroll past a menu to see the game. */}
            <div className="order-1 lg:order-2 w-full flex justify-center min-w-0">
            {gameMode === 'local' ? (
              <LocalGame
                onReturnToLobby={handleReturnToLobby}
                profile={profile}
                onRoundStateChange={setLocalRoundOver}
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
                forfeitNonce={practiceForfeitNonce}
                onRoundStateChange={handlePracticeRoundState}
                onProgressionDone={finishExit}
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
                serverGameEnd={serverGameEnd}
                onReturnToLobby={handleReturnToLobby}
                onRematchRequest={() => {}}
                onRoundStateChange={setOnlineRoundOver}
              />
            )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
