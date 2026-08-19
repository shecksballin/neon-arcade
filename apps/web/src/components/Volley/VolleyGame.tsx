import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import VolleyLobby from './VolleyLobby';
import PingPongGame from './PingPongGame';
// PRACTICE-ONLY: Neon Bucks wagering happens before a COMPUTER match. The
// online path never stakes anything — no SOL, no Neon Bucks.
import { WagerMenu } from '../NeonBucks/WagerMenu';
// Shared matchmaking screen — identical copy/look in every online game.
import SearchingForMatch from '../common/SearchingForMatch';
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
  // Live queue occupancy from `queue:status`, shown while searching.
  const [queueCount, setQueueCount] = useState<{ current: number; needed: number } | null>(null);
  const [wagerAmount, setWagerAmount] = useState<number>(0);

  // Singleton — stable across renders, NOT connected until connectGameSocket().
  const socket = getSocket();

  useEffect(() => {
    onGameStatusChange?.(gameState !== 'lobby');
  }, [gameState, onGameStatusChange]);

  // Last findVolleyGame payload — replayed if the socket reconnects while we
  // are still searching (a reconnect gives a new socket.id, so the server's
  // queue slot for the old id is stale).
  const findPayloadRef = useRef<{ matchMode: 'classic' | 'bestof3' | 'sudden' } | null>(null);
  // Mirror of gameState for listeners/cleanups that must not re-subscribe.
  const gameStateRef = useRef(gameState);
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    // Named handlers + handler-specific socket.off — the socket is shared
    // with the other games, so blanket .off('event') would strip theirs.
    // Legacy ack. The searching screen is already up (set optimistically on
    // click), so this only confirms — it must never overwrite a live game.
    const onWaiting = () => setGameState((s) => (s === 'lobby' ? 'waiting' : s));
    // Authoritative, never-silent queue state from the shared server queue.
    const onQueueStatus = (data: any) => {
      if (data?.game !== 'volley') return; // shared socket — ignore other games
      if (data.inQueue) {
        // Still searching — surface how many are queuing alongside you.
        setQueueCount({ current: data.current ?? 1, needed: data.needed ?? 2 });
        return;
      }
      // inQueue:false means "not queued AND no match started" (a started match
      // arrives as volleyGameStart) — so drop the searching screen.
      setGameState((s) => (s === 'waiting' ? 'lobby' : s));
    };
    const onConnect = () => {
      if (gameStateRef.current === 'waiting' && findPayloadRef.current) {
        socket.emit('findVolleyGame', findPayloadRef.current);
      }
    };
    const onVolleyGameStart = (data: any) => {
      setGameData(data);
      setGameMode('multiplayer');
      setGameState('playing');
    };
    // A mid-match disconnect is handled ENTIRELY by the server's
    // `volleyEnded { reason: 'disconnect' }` — PingPongGame renders the
    // forfeit win on its results screen. This listener only exists for the
    // legacy event name: it must NOT blocking-alert() and dump the player to
    // the lobby past the results screen (and on the shared socket, chess
    // emits the same event name — a volley player must never eat a chess
    // game's alert).
    const onOpponentDisconnected = () => {};
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
    socket.on('queue:status', onQueueStatus);
    socket.on('connect', onConnect);
    socket.on('volleyGameStart', onVolleyGameStart);
    socket.on('opponentDisconnected', onOpponentDisconnected);
    socket.on('connect_error', onConnectError);
    socket.on('gameAuthError', onGameAuthError);

    return () => {
      socket.off('waiting', onWaiting);
      socket.off('queue:status', onQueueStatus);
      socket.off('connect', onConnect);
      socket.off('volleyGameStart', onVolleyGameStart);
      socket.off('opponentDisconnected', onOpponentDisconnected);
      socket.off('connect_error', onConnectError);
      socket.off('gameAuthError', onGameAuthError);
    };
  }, [gameState, socket]);

  // Free our queue slot if the whole screen goes away mid-search (route
  // change, arcade exit, hot reload). Cancel covers the in-app path and the
  // server also sweeps queue slots on disconnect.
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
    findPayloadRef.current = { matchMode: player.matchMode };

    // OPTIMISTIC: the SEARCHING FOR ONLINE MATCH screen goes up on THIS click,
    // never on the server's ack — a dropped/absent reply used to leave the UI
    // frozen on the lobby. Online play stakes nothing (no SOL, no Neon Bucks).
    setGameState('waiting');
    gameStateRef.current = 'waiting'; // eager: listeners/cleanup read the ref
    setGameMode('multiplayer');
    setGameData(null);

    // Lazy connect: only touches the network when entering online mode.
    const s = connectGameSocket();
    // Emits are buffered by socket.io until the connection is up.
    s.emit('findVolleyGame', fullPlayerInfo);

    if (!s.connected && !s.active) {
      // Not connected and not even trying (no auth token stored) — the queue
      // can never be joined, so don't spin on a screen that can't resolve.
      console.warn('[volley] game socket is not connecting — sign in to play online');
      setGameState('lobby');
      gameStateRef.current = 'lobby';
      setGameMode(null);
    }
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
          <motion.div key="waiting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full w-full">
            {/* Shared matchmaking screen — same copy and look in every game.
                The PLAYERS n/N line shows how many are queuing alongside you. */}
            <SearchingForMatch
              playersInQueue={queueCount?.current}
              playersNeeded={queueCount?.needed}
              onCancel={() => {
                // Tell the server to drop our queue entry — without this the
                // cancelled player could still get yanked into a match.
                socket.emit('leaveVolleyQueue');
                setGameState('lobby');
                gameStateRef.current = 'lobby'; // unmount cleanup must not re-emit
                setGameMode(null);
                findPayloadRef.current = null; // stop the reconnect replay
              }}
            />
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
               // NO MONEY ONLINE: the stake only ever belongs to a practice
               // (computer) match, so it is hard-zeroed on the online path.
               wagerAmount={gameMode === 'computer' ? wagerAmount : 0}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default VolleyGame;
