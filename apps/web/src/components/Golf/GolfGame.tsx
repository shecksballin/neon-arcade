import React, { useCallback, useState } from 'react';
import GolfLobby from './GolfLobby';
import NeonGolfClash from './NeonGolfClash';
import GameBackButton from '../common/GameBackButton';
import { SearchingForMatch } from '../common/SearchingForMatch';
import { OnlineMatchBanner } from '../common/OnlineMatchBanner';
import {
  useOnlineLobbyQueue,
  useOnlineMatchBridge,
  type OnlineMatch,
  useLobbyScoreDuel,
} from '../common/onlineLobbyMatch';
import LobbyDuelResults from '../common/LobbyDuelResults';

interface GolfGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inGame: boolean) => void;
}

/**
 * Neon Golf Clash host: lobby → (online) SEARCHING FOR ONLINE MATCH → round.
 *
 * PRACTICE is untouched — it boots the iframe immediately, exactly as before.
 * ONLINE now goes through real server matchmaking (socket/games/lobbyGames.ts):
 * the searching screen appears on click (optimistically, never waiting for a
 * server ack) and the round only starts once a real opponent is matched.
 *
 * Honest scope note: the round that then boots is still the game's own local
 * simulation. The matched roster is published for the iframe to pick up (see
 * useOnlineMatchBridge) and shown in a banner, but Golf itself does not sync
 * play between the two players yet.
 */
const GolfGame = ({ onExit, onGameStatusChange }: GolfGameProps) => {
  // Practice = local round with bots. Match = a real matched online round.
  const [practice, setPractice] = useState(false);
  const [match, setMatch] = useState<OnlineMatch | null>(null);

  const handleMatched = useCallback((found: OnlineMatch) => setMatch(found), []);
  // findMatch / cancel / leaveMatch are stable, so the callbacks below are too.
  const { searching, playersInQueue, playersNeeded, error, findMatch, cancel, leaveMatch } =
    useOnlineLobbyQueue('golf', handleMatched);

  // Publish the roster (localStorage + postMessage) while the online round runs.
  useOnlineMatchBridge(match);

  // Score duel: forward the iframe's end-of-round score, receive the verdict.
  const { duelEnd, clearDuelEnd, playerLeft } = useLobbyScoreDuel(
    match,
    'neon-golf:result',
    // Beating your CPU dominates the score (1000 + rounds won): raw round
    // wins alone tied every both-won and both-swept match, crowning two
    // "winners" — including two LOSERS at 0-0.
    (d) => {
      const r = d as { won?: boolean; rounds?: number };
      return (r.won ? 1000 : 0) + Number(r.rounds ?? 0);
    }
  );

  const playing = practice || match !== null;

  React.useEffect(() => {
    onGameStatusChange?.(playing);
  }, [playing, onGameStatusChange]);

  /** Back to the lobby from a round — tells the server we left the match. */
  const leaveRound = useCallback(() => {
    if (match) leaveMatch(match.matchId);
    setMatch(null);
    setPractice(false);
  }, [match, leaveMatch]);

  if (playing) {
    return (
      <div className="relative w-full h-full">
        <NeonGolfClash onExit={leaveRound} />
        {match && <OnlineMatchBanner match={match} duration={0} placement="bottom" />}
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
          // 1v1 — the counter is hidden unless the server asks for a bigger roster.
          playersInQueue={playersInQueue}
          playersNeeded={playersNeeded}
          onCancel={cancel}
        />
      </div>
    );
  }

  return (
    <div className="w-full h-full relative">
      <GameBackButton onClick={onExit} title="Back to arcade" positionClassName="absolute top-6 left-6 z-50" />
      <GolfLobby
        onFindGame={() => findMatch('classic')}
        onPlayComputer={() => setPractice(true)}
        onExit={onExit}
        error={error}
      />
    </div>
  );
};

export default GolfGame;
