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
} from '../common/onlineLobbyMatch';

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
        {match && <OnlineMatchBanner match={match} />}
      </div>
    );
  }

  if (searching) {
    return (
      <div className="w-full h-full relative bg-[#081616]">
        <GameBackButton onClick={onExit} title="Back to arcade" positionClassName="absolute top-6 left-6 z-50" />
        <SearchingForMatch
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
