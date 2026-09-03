/**
 * NEON KICKOFF — arcade wrapper (lobby · practice · online · private wager)
 * ========================================================================
 * The 3D shootout itself lives in ./game (PenaltyCore + a zustand store).
 * This wrapper is the arcade-facing shell that gives it the exact same
 * plumbing as every other game:
 *
 *   LOBBY      the standard lobby look (big title, level strip, mode cards:
 *              Practice / Online Match / Private Wager, LobbyModeTiles).
 *   PRACTICE   PenaltyCore vs the built-in AI. The game's own menu screen is
 *              its front door (per design, minus the old mode cards); wins
 *              and losses self-report XP through usePracticeXp and chain the
 *              shared progression overlay.
 *   ONLINE     server-authoritative shootout (socket/games/kickoff.ts):
 *              queue → kickoff_match seats us → the STORE plays every kick
 *              from the server's resolved payloads → arcade results screen +
 *              match:progression overlays. Forfeits (leave/disconnect) award
 *              the opponent the win, exactly like chess/connect/volley.
 *   PRIVATE    the shared PrivateWagerRoom (gameKey 'kickoff'); a started
 *              room drives our normal find event server-side, so the match
 *              takes over through the same kickoff_match listener.
 *
 * UNLOADING (the "stop loading after exit" requirement): App lazy-mounts
 * this chunk per visit and unmounts it on exit — R3F disposes the Canvas'
 * WebGL context on unmount, every socket listener below is removed in the
 * effect cleanup, and the store is reset to the menu screen so no ticker
 * work survives. Server-side, exiting mid-match emits kickoff_leave and the
 * server destroys the game (or forfeits it) immediately.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Globe, Swords } from 'lucide-react';
import GameBackButton from '../common/GameBackButton';
import { GlobalSpotlight, ParticleCard } from '../glass/MagicGameTile';
import { LibraryBlob } from '../glass/LibraryBlob';
import LobbyModeTiles from '../common/LobbyModeTiles';
import { LobbyLevelStrip } from '../common/LobbyLevelStrip';
import { SearchingForMatch } from '../common/SearchingForMatch';
import { ResultsScreen } from '../NeonBucks/ResultsScreen';
import { PostGameProgression } from '../common/PostGameProgression';
import { useGuardedExit } from '../common/exitGuard';
import PrivateWagerRoom from '../social/PrivateWagerRoom';
import { usePrivateWagerStarted } from '../social/PrivateWagerInvite';
import {
  connectGameSocket,
  getSocket,
  useMatchProgression,
} from '../../hooks/useGameSocket';
import { usePracticeXp } from '../../hooks/usePracticeXp';
import PenaltyCore from './game/PenaltyCore';
import { useGame } from './game/store';
import { goals } from './game/shootout';
import type { Dir, Zone } from './game/types';

interface NeonKickoffGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inProgress: boolean) => void;
}

type WrapperView = 'lobby' | 'practice' | 'searching' | 'online';

export default function NeonKickoffGame({
  onExit,
  profile,
  onGameStatusChange,
}: NeonKickoffGameProps) {
  const [view, setView] = useState<WrapperView>('lobby');
  const [showPrivateWager, setShowPrivateWager] = useState(false);
  const [queueCount, setQueueCount] = useState<{ current: number; needed: number } | null>(null);
  // One-line story under the online results verdict (forfeit wins).
  const [endNote, setEndNote] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // The game store (module-level zustand — safe to read from the wrapper).
  const screen = useGame((s) => s.screen);
  const phase = useGame((s) => s.phase);
  const paused = useGame((s) => s.paused);
  const mode = useGame((s) => s.mode);
  const shootout = useGame((s) => s.shootout);
  const togglePause = useGame((s) => s.togglePause);

  // Progression plumbing — identical to the other games.
  const { progression, clear: clearProgression } = useMatchProgression();
  const { practiceProgression, armRound, reportRound, clearPracticeProgression } =
    usePracticeXp('kickoff');

  // ── nav-bar state ─────────────────────────────────────────────────────
  useEffect(() => {
    onGameStatusChange?.(view !== 'lobby');
  }, [view, onGameStatusChange]);

  // ── matchmaking + online bridge ───────────────────────────────────────
  const enterMatchmaking = useCallback(() => {
    const socket = connectGameSocket();
    setView('searching');
    setEndNote(null);
    // A rematch inside the overlay's lead-in must not let the LAST match's
    // "+XP / RANKED UP" replay over the next one (same rule as every game).
    clearProgression();
    clearPracticeProgression();
    socket.emit('kickoff_find', {});
  }, [clearProgression, clearPracticeProgression]);

  const cancelSearch = useCallback(() => {
    getSocket().emit('kickoff_leaveQueue');
    setView('lobby');
  }, []);

  useEffect(() => {
    const socket = getSocket();

    const onMatch = (data: { gameId: string; youAre: 1 | 2; opponent: string }) => {
      setEndNote(null);
      useGame.getState().startOnlineMatch({
        gameId: data.gameId,
        mySide: data.youAre,
        opponent: data.opponent,
        emitStrike: (dir: Dir, zone: Zone) =>
          getSocket().emit('kickoff_strike', { gameId: data.gameId, dir, zone }),
        emitGuess: (dir: Dir) =>
          getSocket().emit('kickoff_guess', { gameId: data.gameId, dir }),
      });
      setView('online');
    };

    const onKick = (k: Parameters<ReturnType<typeof useGame.getState>['onlineServerKick']>[0]) => {
      useGame.getState().onlineServerKick(k);
    };

    const onEnded = (e: { winner: 1 | 2 | 0; reason: string }) => {
      const g = useGame.getState();
      const mySide = g.online?.mySide;
      if (!mySide) return;
      const won = e.winner === mySide;
      if (e.reason === 'forfeit') {
        setEndNote(
          won
            ? 'Your opponent left the game — you win by forfeit'
            : 'You left the shootout — your opponent takes the win'
        );
      } else if (e.reason === 'exhausted') {
        // The server's round cap (both sides idling forever) calls it a draw.
        setEndNote('Called after twenty rounds each — the shootout is a draw');
      }
      g.onlineServerEnded({ won, reason: e.reason });
    };

    // Server refusals + auth failures must bounce the radar back to the
    // lobby (same contract as chess/volley/connect) — and a dropped socket
    // mid-match means the server has ALREADY forfeited us: say so rather
    // than leaving a frozen ring waiting on events that can never arrive
    // (reconnection mints a new socket id the room no longer contains).
    const onGameAuthError = (data: { message?: string; code?: string }) => {
      console.warn('[kickoff] cannot play online:', data?.message ?? data?.code);
      setView((v) => (v === 'searching' ? 'lobby' : v));
    };
    const onConnectError = (err: Error) => {
      if (err.message === 'unauthorized' || err.message === 'auth_unavailable') {
        console.warn('[kickoff] socket auth failed:', err.message);
        setView((v) => (v === 'searching' ? 'lobby' : v));
      }
    };
    const onSocketDisconnect = () => {
      const g = useGame.getState();
      if (g.mode === 'online' && g.online && g.phase !== 'over') {
        setEndNote('Connection lost — the match was forfeited');
        g.onlineServerEnded({ won: false, reason: 'forfeit' });
      }
    };

    const onQueueStatus = (data: {
      game?: string;
      inQueue?: boolean;
      current?: number;
      needed?: number;
    }) => {
      if (data?.game !== 'kickoff') return;
      if (!data.inQueue) {
        setQueueCount(null);
        return;
      }
      setQueueCount({
        current: typeof data.current === 'number' ? data.current : 1,
        needed: typeof data.needed === 'number' ? data.needed : 2,
      });
    };

    socket.on('kickoff_match', onMatch);
    socket.on('kickoff_kick', onKick);
    socket.on('kickoff_ended', onEnded);
    socket.on('queue:status', onQueueStatus);
    socket.on('gameAuthError', onGameAuthError);
    socket.on('connect_error', onConnectError);
    socket.on('disconnect', onSocketDisconnect);
    return () => {
      socket.off('kickoff_match', onMatch);
      socket.off('kickoff_kick', onKick);
      socket.off('kickoff_ended', onEnded);
      socket.off('queue:status', onQueueStatus);
      socket.off('gameAuthError', onGameAuthError);
      socket.off('connect_error', onConnectError);
      socket.off('disconnect', onSocketDisconnect);
    };
  }, []);

  // Inject where an online quit lands (see game/ui/PauseMenu). Cleared on
  // unmount so a stale closure can never navigate a future mount.
  useEffect(() => {
    useGame.setState({
      wrapperExit: () => {
        useGame.getState().quitToMenu();
        setView('lobby');
      },
    });
    return () => {
      useGame.setState({ wrapperExit: null });
    };
  }, []);

  // A private room accepted from the nav-bar bell can start a match while we
  // sit in the lobby — the started room drives our find event server-side,
  // and the kickoff_match listener above takes over. Just show the radar.
  usePrivateWagerStarted('kickoff', () => setView('searching'));

  // Leaving the whole game view (unmount) while queued or mid-match: free the
  // slot / forfeit server-side, and put the store back on its menu so no
  // ticker work survives into the next visit.
  useEffect(() => {
    return () => {
      const g = useGame.getState();
      const socket = getSocket();
      socket.emit('kickoff_leaveQueue');
      if (g.mode === 'online' && g.online && g.phase !== 'over') {
        socket.emit('kickoff_leave');
      }
      g.quitToMenu();
    };
  }, []);

  // ── exit guard (shared arcade contract) ───────────────────────────────
  const guardActive =
    (view === 'practice' || view === 'online') && screen === 'game' && phase !== 'over';

  const { finishExit, abortPendingExit, confirmDialog } = useGuardedExit({
    active: guardActive,
    onForfeit: () => {
      const g = useGame.getState();
      if (g.mode === 'online' && g.online) {
        // Server ends it for both seats: kickoff_ended + match:progression
        // still reach us (we stay mounted), so results + overlays play out.
        getSocket().emit('kickoff_leave');
        return 'wait';
      }
      // Practice: stamp the loss; the phase-'over' watcher reports the XP.
      g.forfeitMatch();
      return 'wait';
    },
    copy: () =>
      useGame.getState().mode === 'online'
        ? {
            message:
              'Leaving now forfeits the shootout — your opponent takes the win. Your results and progression will play before you go.',
            confirmLabel: 'Forfeit & leave',
          }
        : {
            message:
              'Leaving now ends the shootout as a loss. Your results and XP will play before you go.',
            confirmLabel: 'Take the loss & leave',
          },
  });

  // ── practice XP: one report per finished shootout ─────────────────────
  const reportedRef = useRef(false);
  useEffect(() => {
    if (screen === 'game' && phase !== 'over') reportedRef.current = false;
    if (phase === 'over' && mode === 'practice' && !reportedRef.current) {
      reportedRef.current = true;
      reportRound({
        result: shootout.winner === 'player' ? 'win' : 'loss',
        score: goals(shootout, 'player'),
      });
    }
  }, [phase, screen, mode, shootout, reportRound]);

  // Fresh round guards whenever a match starts (practice or online).
  useEffect(() => {
    if (screen === 'game' && phase === 'intro') {
      armRound();
    }
  }, [screen, phase, armRound]);

  // ESC toggles the game's pause overlay while a round is live (the old
  // Menu pill's exact conditions). The overlay's own Resume/quit buttons
  // handle the rest; togglePause is idempotent about re-entry.
  //
  // ‼️ HOOK ORDER: this block MUST live above the early `if (view === …)`
  // returns below. It used to sit after them, so leaving the lobby changed
  // the number of hooks between renders and React threw ("rendered more
  // hooks than during the previous render") the moment ANY match started —
  // practice, wager and private wager alike. tsc cannot catch this.
  const canPause = screen === 'game' && phase !== 'over';
  const canPauseRef = useRef(false);
  canPauseRef.current = canPause;
  useEffect(() => {
    if (!(view === 'practice' || view === 'online')) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (!canPauseRef.current) return;
      useGame.getState().togglePause();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);

  // ── views ─────────────────────────────────────────────────────────────

  if (view === 'lobby') {
    return (
      <div className="min-h-[100dvh] bg-[#081616] flex flex-col items-center justify-center p-6 relative overflow-hidden">
        <LibraryBlob />
        <GlobalSpotlight gridRef={containerRef} />

        {/* Ambient glow, same recipe as the sibling lobbies. */}
        <div className="absolute inset-0 opacity-20 pointer-events-none">
          <div className="absolute top-20 left-20 w-96 h-96 bg-[#00FFD1] rounded-full blur-[120px] opacity-20 animate-pulse" />
          <div
            className="absolute bottom-20 right-20 w-96 h-96 bg-[#FF0080] rounded-full blur-[120px] opacity-20 animate-pulse"
            style={{ animationDelay: '1s' }}
          />
        </div>

        <div ref={containerRef} className="relative z-10 text-center space-y-8 max-w-2xl w-full">
          <div className="space-y-2">
            <h1 className="text-6xl md:text-8xl font-black text-[#FFFFFD] drop-shadow-[0_0_20px_rgba(0,255,209,0.6)] uppercase tracking-tighter italic">
              NEON KICKOFF
            </h1>
            <p className="text-[10px] font-mono tracking-[0.3em] uppercase text-[#B1C5FF]/50">
              penalty shootout · hold your nerve
            </p>
          </div>

          {/* Level progression — compact strip under the title. */}
          <LobbyLevelStrip />

          {/* Mode cards — the EXACT card recipe every sibling lobby uses
              (Golf/Clumsy/Volley): mint-gradient Wager Match first with the
              top accent strip, then Private Wager and Practice as bordered
              glow cards, all centred with the w-8 icons. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full text-left">
            <ParticleCard
              onClick={enterMatchmaking}
              className="magic-bento-card magic-bento-card--border-glow px-8 py-6 bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] rounded-2xl hover:shadow-[0_0_50px_rgba(0,255,209,0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
            >
              <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>
              <Globe className="w-8 h-8 group-hover:rotate-12 transition-transform" />
              <div className="text-center">
                <span className="block font-black text-xl uppercase tracking-tighter italic leading-none">Wager Match</span>
                <span className="block text-[8px] opacity-60 font-bold tracking-widest mt-1">
                  GLOBAL WAGER ARENA
                </span>
              </div>
            </ParticleCard>

            <ParticleCard
              onClick={() => setShowPrivateWager(true)}
              className="magic-bento-card magic-bento-card--border-glow px-8 py-6 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
            >
              <Swords className="w-8 h-8 text-zinc-400 group-hover:rotate-12 transition-transform group-hover:text-[#00FFD1]" />
              <div className="text-center">
                <span className="block font-black text-xl uppercase tracking-tighter italic leading-none">
                  Private Wager
                </span>
                <span className="block text-[8px] text-white/40 font-bold tracking-widest mt-1">
                  INVITE A FRIEND
                </span>
              </div>
            </ParticleCard>

            <ParticleCard
              onClick={() => {
                setView('practice');
                useGame.getState().quitToMenu(); // land on the game's menu
              }}
              className="magic-bento-card magic-bento-card--border-glow px-8 py-6 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
            >
              <Bot className="w-8 h-8 text-zinc-400 group-hover:rotate-12 transition-transform" />
              <div className="text-center">
                <span className="block font-black text-xl uppercase tracking-tighter italic leading-none">
                  Practice
                </span>
                <span className="block text-[8px] text-white/40 font-bold tracking-widest mt-1">
                  VS THE AI KEEPER
                </span>
              </div>
            </ParticleCard>
          </div>

          <p className="text-[9px] font-mono tracking-[0.3em] uppercase text-[#B1C5FF]/40">
            Online matches are free — no stake, no entry fee
          </p>

          {/* Shared lobby footer — see common/LobbyModeTiles. */}
          <LobbyModeTiles />
        </div>

        {showPrivateWager && (
          <PrivateWagerRoom
            gameKey="kickoff"
            mode="1v1"
            onClose={() => setShowPrivateWager(false)}
            onStarted={() => setView('searching')}
          />
        )}
      </div>
    );
  }

  if (view === 'searching') {
    return (
      <SearchingForMatch
        variant="page"
        onCancel={cancelSearch}
        playersInQueue={queueCount?.current}
        playersNeeded={queueCount?.needed}
      />
    );
  }

  // practice + online share the PenaltyCore mount.
  const onlineOver = view === 'online' && phase === 'over';

  return (
    <div className="relative w-full h-[100dvh] bg-[#081616] overflow-hidden">
      <PenaltyCore />

      {/* Back to the arcade lobby from the game's own MENU screen — the menu
          is kickoff's mini-lobby, so the back chevron lives here (games
          themselves exit through the pause menu / exit guard). */}
      {view === 'practice' && screen === 'menu' && (
        <GameBackButton
          onClick={() => setView('lobby')}
          title="Back to Neon Kickoff lobby"
          positionClassName="absolute top-6 left-6 z-[95]"
        />
      )}

      {/* ESC opens the game's own pause overlay (the visible Menu pill was
          removed by request — same convention as every other game now). */}

      {/* ONLINE ending — the arcade's shared results screen (the practice
          board inside PenaltyCore is suppressed online). */}
      {onlineOver && (
        <ResultsScreen
          won={shootout.winner === 'player'}
          stake={0}
          winnings={0}
          gameMode="Online"
          moneyless
          note={endNote}
          onRematch={() => {
            abortPendingExit();
            enterMatchmaking();
          }}
          onExit={() => {
            useGame.getState().quitToMenu();
            setView('lobby');
          }}
        />
      )}

      {/* Level/rank progression — chained after whichever results screen is
          up. GATED ON phase 'over': kickoff is the one game whose end event
          (and progression payload) lands ~5s BEFORE the final kick finishes
          its theatre, and the overlay must not play over a ball still in
          flight. onDone also releases a guarded exit waiting on us. */}
      {phase === 'over' && (
        <PostGameProgression
          progression={progression ?? practiceProgression}
          onDone={() => {
            clearProgression();
            clearPracticeProgression();
            finishExit();
          }}
        />
      )}

      {/* Shared "leaving forfeits" confirmation. */}
      {confirmDialog}

    </div>
  );
}

