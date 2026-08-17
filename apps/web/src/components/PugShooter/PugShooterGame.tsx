import React, { Suspense, useCallback, useRef, useState } from 'react';
import PugShooterLobby, { PugShooterMatchConfig } from './PugShooterLobby';
import { Loader2 } from 'lucide-react';
import GameBackButton from '../common/GameBackButton';
import { SearchingForMatch } from '../common/SearchingForMatch';
import { OnlineMatchBanner } from '../common/OnlineMatchBanner';
import {
  useOnlineLobbyQueue,
  useOnlineMatchBridge,
  type OnlineMatch,
} from '../common/onlineLobbyMatch';

// Lazy-loaded so the iframe host (and with it the whole three.js + Rapier game
// behind it) is only fetched when the player starts a match, keeping the
// arcade's initial load fast. The queue screen never touches it.
const PugShooterPlay = React.lazy(() => import('./PugShooterPlay'));

interface PugShooterGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inGame: boolean) => void;
}

function PugShooterLoading() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#050d1c] text-white">
      <Loader2 className="w-10 h-10 text-[#00FFD1] animate-spin" />
      <p className="font-black tracking-[0.3em] uppercase text-sm text-[#00FFD1]">
        Loading Neon Pug Shooter…
      </p>
    </div>
  );
}

/**
 * Neon Pug Shooter host: lobby → (online) SEARCHING FOR ONLINE MATCH → round.
 *
 * PRACTICE is untouched — the chosen mode/map/difficulty boot the local bot
 * match immediately. ONLINE now queues on the server
 * (socket/games/lobbyGames.ts, queue mode = the selected game mode) and only
 * boots once real players are matched; the searching screen goes up on click,
 * never waiting for a server ack.
 *
 * Honest scope note: the round that boots is still the local simulation with
 * the game's own bots. The matched roster is published for the iframe
 * (useOnlineMatchBridge) and shown in a banner, but no shots, positions or
 * scores are shared between the matched players yet.
 */
const PugShooterGame = ({ onExit, onGameStatusChange }: PugShooterGameProps) => {
  // Practice = boot straight away. Online = boot only once matched.
  const [practiceConfig, setPracticeConfig] = useState<PugShooterMatchConfig | null>(null);
  const [match, setMatch] = useState<OnlineMatch | null>(null);
  // The mode/map/difficulty chosen when the player hit ONLINE MATCH — held
  // until the server pairs them, then used to boot the round.
  const queuedConfig = useRef<PugShooterMatchConfig | null>(null);
  const [onlineConfig, setOnlineConfig] = useState<PugShooterMatchConfig | null>(null);

  const handleMatched = useCallback((found: OnlineMatch) => {
    setOnlineConfig(queuedConfig.current);
    setMatch(found);
  }, []);
  // findMatch / cancel / leaveMatch are stable, so the callbacks below are too.
  const { searching, playersInQueue, playersNeeded, error, findMatch, cancel, leaveMatch } =
    useOnlineLobbyQueue('pugshooter', handleMatched);

  useOnlineMatchBridge(match);

  const activeConfig = practiceConfig ?? (match ? onlineConfig : null);

  React.useEffect(() => {
    onGameStatusChange?.(activeConfig !== null);
  }, [activeConfig, onGameStatusChange]);

  /** ONLINE MATCH clicked — remember the loadout, then queue for its mode. */
  const findOnline = useCallback(
    (config: PugShooterMatchConfig) => {
      queuedConfig.current = config;
      findMatch(config.mode);
    },
    [findMatch]
  );

  /** Back to the lobby from a round — tells the server we left the match. */
  const leaveRound = useCallback(() => {
    if (match) leaveMatch(match.matchId);
    setMatch(null);
    setOnlineConfig(null);
    setPracticeConfig(null);
  }, [match, leaveMatch]);

  if (activeConfig) {
    return (
      <div className="relative w-full h-full bg-[#050d1c]">
        <Suspense fallback={<PugShooterLoading />}>
          <PugShooterPlay config={activeConfig} onExit={leaveRound} />
        </Suspense>
        {match && <OnlineMatchBanner match={match} />}
      </div>
    );
  }

  if (searching) {
    return (
      <div className="w-full h-full relative bg-[#081616]">
        <GameBackButton onClick={onExit} title="Back to arcade" positionClassName="absolute top-6 left-6 z-50" />
        <SearchingForMatch
          playersInQueue={playersInQueue}
          // Only show PLAYERS: n / N when the mode wants more than a pair.
          playersNeeded={playersNeeded}
          onCancel={cancel}
        />
      </div>
    );
  }

  return (
    <div className="w-full h-full relative">
      <GameBackButton onClick={onExit} title="Back to arcade" positionClassName="absolute top-6 left-6 z-50" />
      <PugShooterLobby
        onFindGame={findOnline}
        onPlayComputer={setPracticeConfig}
        onExit={onExit}
        error={error}
      />
    </div>
  );
};

export default PugShooterGame;
