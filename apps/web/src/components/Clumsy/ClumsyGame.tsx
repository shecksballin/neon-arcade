import React, { Suspense, useCallback, useState } from 'react';
import ClumsyLobby from './ClumsyLobby';
import { Loader2 } from 'lucide-react';
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

// Lazy-loaded so the heavy three.js + Rapier game bundle is only fetched when
// the player starts a match, keeping the arcade's initial load fast. The queue
// screen never touches it — nothing downloads while searching.
const ClumsyPlay = React.lazy(() => import('./ClumsyPlay'));

interface ClumsyGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inGame: boolean) => void;
}

function ClumsyLoading() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#0d0824] text-white">
      <Loader2 className="w-10 h-10 text-[#00FFD1] animate-spin" />
      <p className="font-black tracking-[0.3em] uppercase text-sm text-[#00FFD1]">
        Loading Neon Clumsy…
      </p>
    </div>
  );
}

/**
 * Neon Clumsy host: lobby → (online) SEARCHING FOR ONLINE MATCH → round.
 *
 * PRACTICE is untouched. ONLINE now queues on the server
 * (socket/games/lobbyGames.ts) and only boots once a real opponent is matched;
 * the searching screen goes up on click, never waiting for a server ack.
 *
 * Honest scope note: the round itself is still Clumsy's local simulation. The
 * matched roster is published for the iframe (useOnlineMatchBridge) and shown
 * in a banner, but the two players' runs are not synced yet.
 */
const ClumsyGame = ({ onExit, profile, onGameStatusChange }: ClumsyGameProps) => {
  const [practice, setPractice] = useState(false);
  const [match, setMatch] = useState<OnlineMatch | null>(null);

  const handleMatched = useCallback((found: OnlineMatch) => setMatch(found), []);
  // findMatch / cancel / leaveMatch are stable, so the callbacks below are too.
  const { searching, playersInQueue, playersNeeded, error, findMatch, cancel, leaveMatch, voteOpen, votes, votesNeeded, voteStart } =
    useOnlineLobbyQueue('clumsy', handleMatched);

  useOnlineMatchBridge(match);

  // Score duel: forward the iframe's end-of-round score, receive the verdict.
  const { duelEnd, clearDuelEnd, playerLeft } = useLobbyScoreDuel(
    match,
    'neon-clumsy:result',
    (d) => Number((d as {tiles?: number}).tiles ?? 0)
  );

  const playing = practice || match !== null;

  React.useEffect(() => {
    onGameStatusChange?.(playing);
  }, [playing, onGameStatusChange]);

  const leaveRound = useCallback(() => {
    if (match) leaveMatch(match.matchId);
    setMatch(null);
    setPractice(false);
  }, [match, leaveMatch]);

  if (playing) {
    return (
      <div className="relative w-full h-full bg-[#0d0824]">
        <Suspense fallback={<ClumsyLoading />}>
          {/* No second PLAY press: the round boots straight into its countdown,
              under the arcade profile name. */}
          <ClumsyPlay onExit={leaveRound} playerName={profile?.name} />
        </Suspense>
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
          playersInQueue={playersInQueue}
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
      <GameBackButton onClick={onExit} title="Back to arcade" positionClassName="absolute top-6 left-6 z-50" />
      <ClumsyLobby
        onFindGame={() => findMatch('classic')}
        onPlayComputer={() => setPractice(true)}
        onExit={onExit}
        error={error}
      />
    </div>
  );
};

export default ClumsyGame;
