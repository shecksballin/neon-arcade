import React, { Suspense, useCallback, useRef, useState } from 'react';
import PugShooterLobby, { PugShooterMatchConfig } from './PugShooterLobby';
import { Loader2 } from 'lucide-react';
import { SearchingForMatch } from '../common/SearchingForMatch';
import { OnlineMatchBanner } from '../common/OnlineMatchBanner';
import {
  useOnlineLobbyQueue,
  useOnlineMatchBridge,
  type OnlineMatch,
  useLobbyScoreDuel,
} from '../common/onlineLobbyMatch';
import LobbyDuelResults from '../common/LobbyDuelResults';

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
const PugShooterGame = ({ onExit, profile, onGameStatusChange }: PugShooterGameProps) => {
  // Practice = boot straight away. Online = boot only once matched.
  const [practiceConfig, setPracticeConfig] = useState<PugShooterMatchConfig | null>(null);
  const [match, setMatch] = useState<OnlineMatch | null>(null);
  // The mode/map/difficulty chosen when the player hit ONLINE MATCH — held
  // until the server pairs them, then used to boot the round.
  const queuedConfig = useRef<PugShooterMatchConfig | null>(null);
  const [onlineConfig, setOnlineConfig] = useState<PugShooterMatchConfig | null>(null);

  const handleMatched = useCallback((found: OnlineMatch) => {
    // PRIVATE-WAGER PATH: the room drives lobbyGame:find server-side, so no
    // lobby click ever stored a loadout — queuedConfig is null and (before
    // this fallback) the round could never boot: the room closed itself on
    // private:started, both players were dumped back on the lobby, and the
    // orphaned server match corrupted later queues. The server's match mode
    // is authoritative; map/difficulty fall back to defaults.
    // The server's mode may be an ffa:<map> composite (per-map lobbies).
    const [rawMode, rawMap] = String(found.mode).split(':');
    const serverMode = (['ffa', 'duel', 'duo'] as const).includes(
      rawMode as PugShooterMatchConfig['mode']
    )
      ? (rawMode as PugShooterMatchConfig['mode'])
      : 'ffa';
    const serverMap = (['city', 'warehouse'] as const).includes(
      rawMap as PugShooterMatchConfig['map']
    )
      ? (rawMap as PugShooterMatchConfig['map'])
      : undefined;
    // The SERVER's mode is authoritative. The stored lobby loadout only
    // contributes its map/difficulty when its mode agrees — a stale public
    // DUEL loadout must never boot a private FFA as a 1v1.
    const stored = queuedConfig.current;
    setOnlineConfig(
      stored && stored.mode === serverMode && (!serverMap || stored.map === serverMap)
        ? stored
        : {
            mode: serverMode,
            map: serverMap ?? stored?.map ?? 'city',
            difficulty: stored?.difficulty ?? 'normal',
          }
    );
    setMatch(found);
  }, []);
  // findMatch / cancel / leaveMatch are stable, so the callbacks below are too.
  const { searching, playersInQueue, playersNeeded, error, findMatch, cancel, leaveMatch, voteOpen, votes, votesNeeded, voteStart } =
    useOnlineLobbyQueue('pugshooter', handleMatched);

  useOnlineMatchBridge(match);

  // Score duel: forward the iframe's end-of-round score, receive the verdict.
  const { duelEnd, clearDuelEnd, playerLeft } = useLobbyScoreDuel(
    match,
    'neon-pug-shooter:result',
    (d) => Number((d as {score?: number}).score ?? 0)
  );

  const activeConfig = practiceConfig ?? (match ? onlineConfig : null);

  React.useEffect(() => {
    onGameStatusChange?.(activeConfig !== null);
  }, [activeConfig, onGameStatusChange]);

  /** ONLINE MATCH clicked — remember the loadout, then queue for its mode. */
  const findOnline = useCallback(
    (config: PugShooterMatchConfig) => {
      queuedConfig.current = config;
      // FFA queues are PER MAP (different lobby sizes) — the wire mode
      // carries the map; duel/duo stay plain.
      findMatch(config.mode === 'ffa' ? `ffa:${config.map}` : config.mode);
    },
    [findMatch]
  );

  /** Back to the lobby from a round — tells the server we left the match. */
  const leaveRound = useCallback(() => {
    if (match) leaveMatch(match.matchId);
    queuedConfig.current = null; // a dead loadout must not haunt later matches
    setMatch(null);
    setOnlineConfig(null);
    setPracticeConfig(null);
  }, [match, leaveMatch]);

  if (activeConfig) {
    return (
      <div className="relative w-full h-full bg-[#050d1c]">
        <Suspense fallback={<PugShooterLoading />}>
          <PugShooterPlay config={activeConfig} onExit={leaveRound} profile={profile} />
        </Suspense>
        {match && <OnlineMatchBanner match={match} />}
        {match && playerLeft && !duelEnd && (
          <div className="absolute top-24 left-1/2 -translate-x-1/2 z-40 pointer-events-none rounded-full border border-[#FF6B9A]/40 bg-black/70 px-4 py-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-[#FF6B9A]">
            {playerLeft} left the match
          </div>
        )}
        {duelEnd && (
          <LobbyDuelResults end={duelEnd} onExit={leaveRound} onDismiss={clearDuelEnd} />
        )}
      </div>
    );
  }

  if (searching) {
    return (
      // Shared matchmaking page — Cancel is the only exit (the back
      // button died with the pug-menu rework; it also skipped leaving
      // the queue cleanly).
      <div className="w-full h-full">
        <SearchingForMatch
          variant="page"
          playersInQueue={playersInQueue}
          // Only show PLAYERS: n / N when the mode wants more than a pair.
          playersNeeded={playersNeeded}
          voteOpen={voteOpen}
          votes={votes}
          votesNeeded={votesNeeded}
          onVoteStart={voteStart}
          onCancel={cancel}
        />
      </div>
    );
  }

  return (
    <div className="w-full h-full relative">
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
