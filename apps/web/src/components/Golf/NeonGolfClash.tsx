import { useCallback, useEffect, useRef, useState } from 'react';
import { GamePauseMenu } from '../common/GamePauseMenu';
import { reportGameSession } from '../../lib/sessionXp';
import { usePracticeXp } from '../../hooks/usePracticeXp';
import { useGuardedExit } from '../common/exitGuard';
import { PostGameProgression } from '../common/PostGameProgression';
import { ResultsScreen } from '../NeonBucks/ResultsScreen';
import { hasAuthToken } from '../social/usePresence';

// The standalone game lives in `public/Golf/` so Vite serves it VERBATIM. (A
// `.html` under `src/` gets run through Vite's HTML transform — rewriting its
// module scripts / importmap — which breaks this self-contained game.) It is
// referenced by URL, not imported, so nothing about the 3.3MB document is
// fetched until the <iframe> below mounts.
//
// `?autostart=1` SKIPS THE GAME'S OWN MAIN MENU. This component only mounts once
// the player has already committed to a round — practice, a matched wager queue,
// or a private wager both sides readied up — so the in-iframe PLAY button was a
// second confirmation of a decision already made. The menu itself is untouched
// and still reachable mid-match from PAUSE → MAIN MENU (where the difficulty
// picker lives).
const GAME_SRC = `${import.meta.env.BASE_URL}Golf/NeonGolfClash.html?autostart=1`;

interface NeonGolfClashProps {
  onExit: () => void;
}

/**
 * Iframe loader for the self-contained Neon Golf Clash game.
 *
 * This component (and therefore the <iframe>) is only rendered once the player
 * chooses to play, so the large game document is loaded strictly on demand —
 * never preloaded while the user is still in the lobby.
 *
 * The game speaks outward exactly once per match — `neon-golf:result` when it
 * is decided — which is all this wrapper needs to know when a round is live,
 * and therefore when leaving it is a forfeit (see the exit guard below).
 */
const NeonGolfClash = ({ onExit }: NeonGolfClashProps) => {
  const [loaded, setLoaded] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  /**
   * DETERMINISTIC GPU TEARDOWN. Unmounting only DETACHES the iframe — the
   * game inside registers no unload handler and never loses its WebGL
   * context, so its whole realm (three.js scene, physics WASM heap, decoded
   * assets, a LIVE GPU context) lingered in a detached document until the
   * browser got around to GC. Stack a couple of those and the landing
   * page's own WebGL (fluid cursor + blob) crawls while the WebGL-free
   * library stays fast — exactly the reported symptom. Navigating the
   * frame to about:blank in cleanup forces the inner document to unload
   * NOW, destroying its context and freeing the realm deterministically.
   */
  useEffect(() => {
    const frame = frameRef.current;
    return () => {
      try {
        frame?.contentWindow?.location.replace('about:blank');
      } catch {
        /* same-origin today; never let teardown throw during unmount */
      }
    };
  }, []);

  /**
   * ROUND LIFECYCLE, as far as the iframe tells us. `?autostart=1` means the
   * match is already running the moment the document loads, and the game's
   * only outbound message is its result — so "a round is live" is exactly:
   * the document booted, no result has landed, and we have not already
   * settled it ourselves as a forfeit. Refs mirror the state for the message
   * listener and the forfeit path, which read current values without
   * re-subscribing.
   */
  const [matchOver, setMatchOver] = useState(false);
  const [forfeited, setForfeited] = useState(false);
  const forfeitedRef = useRef(false);
  const roundStartedAtRef = useRef<number | null>(null);

  /**
   * Practice-shaped XP for a forfeit loss: the same metered self-reported
   * path the result message takes, but a DIFFERENT dedupe keyspace
   * (golf:practice:<uuid> vs golf:<roundId>) — which is precisely why the
   * listener below must drop any later result once forfeited, or one round
   * would pay twice.
   */
  const { practiceProgression, armRound, reportRound, clearPracticeProgression } =
    usePracticeXp('golf');

  const { requestExit, finishExit, exitPending, confirmDialog } = useGuardedExit({
    // Live from boot until the match is decided. Never over the loading
    // screen, never after the whistle, never twice.
    //
    // Honest scope: a SECOND match started inside the iframe (end screen →
    // REMATCH, or MAIN MENU → PLAY) announces nothing out here — the game
    // posts results only, and its document is not ours to change in this
    // pass — so the guard stays disarmed for it. Disarmed is the safe way
    // to be wrong: it can fail to ask, never invent a forfeit. The mirror
    // case, the game's own PAUSE → QUIT dropping a live match back to its
    // menu, leaves the guard armed — correctly, since that round was
    // abandoned undecided and leaving still owes it a loss.
    active: loaded && !matchOver && !forfeited,
    onForfeit: () => {
      // Flip the round into ended-as-a-loss on OUR side. The iframe keeps
      // playing underneath the overlays, but the loss reported here is the
      // one settlement — the listener ignores anything it says from now on.
      forfeitedRef.current = true;
      setForfeited(true);
      // Tell the score-duel layer this round no longer counts: the iframe
      // keeps simulating under the results overlay and would otherwise post
      // a real score — letting a player forfeit and still win the verdict.
      window.dispatchEvent(new CustomEvent('neon:duel-forfeit'));
      reportRound({
        result: 'loss',
        durationMs: roundStartedAtRef.current
          ? Date.now() - roundStartedAtRef.current
          : undefined,
      });
      return 'wait';
    },
    copy: {
      message:
        'Leaving now ends the match as a loss. Your results will play before you go.',
      confirmLabel: 'Leave & forfeit',
    },
  });

  // Signed out, the forfeit report goes nowhere and no progression will ever
  // arrive — cue the deferred navigation instead of sitting out the guard's
  // 12s fallback. finishExit still holds the results screen its minimum beat.
  useEffect(() => {
    if (exitPending && forfeited && !hasAuthToken()) finishExit();
  }, [exitPending, forfeited, finishExit]);

  /**
   * PROGRESSION. The match is fought out entirely inside the iframe, so the
   * game posts `neon-golf:result` when it ends and we turn that into XP — the
   * same award every other game in the arcade gets for a finished match. See
   * lib/sessionXp.ts for how an unverifiable result is bounded (clamped,
   * daily-capped, and never allowed near RP).
   */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Same-origin only — the game document is served from our own /public.
      if (event.origin !== window.location.origin) return;

      if (event.data?.type === 'neon-golf:round-start') {
        // A match went live: the first one, and again on every in-game
        // REMATCH. Without the repeat the guard would disarm after round one
        // and a second match would be quittable with no forfeit.
        setMatchOver(false);
        roundStartedAtRef.current = Date.now();
        armRound();
        return;
      }

      if (event.data?.type !== 'neon-golf:result') return;

      // Once forfeited the round is already settled as a loss — a match the
      // iframe goes on to finish underneath the results overlay must not
      // ALSO pay out (double XP; see the dedupe note above).
      if (forfeitedRef.current) return;
      // The whistle has blown: leaving from here on is free again.
      setMatchOver(true);

      const r = event.data;
      void reportGameSession(
        {
          gameKey: 'golf',
          // One player, one CPU fighter: a 1v1 by shape, though nothing here
          // is ranked (self-reported results never touch RP).
          mode: '1v1',
          result: r.won ? 'win' : 'loss',
          // Rounds won is the whole scoreline of a Golf Clash match.
          score: r.rounds,
          durationMs: r.durationMs ?? null,
        },
        `golf:${r.roundId ?? r.durationMs ?? ''}`
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // Refs, setState and armRound (stable useCallback) only, so the listener
    // is mounted once and never churns mid-match.
  }, [armRound]);

  // Both results-screen buttons leave: the forfeited round's iframe is still
  // running its own match underneath and has no inbound channel to restart,
  // so a real "Rematch" cannot be honored here — and while the exit is
  // pending, requestExit runs the navigation immediately (the player is
  // telling us to hurry up).
  const leaveNow = useCallback(() => requestExit(onExit), [requestExit, onExit]);

  return (
    <div className="relative w-full h-full bg-[#081616]">
      {/* Loading overlay shown until the game document finishes loading */}
      {!loaded && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#081616]">
          <div className="w-16 h-16 border-4 border-[#00FFD1]/20 border-t-[#00FFD1] rounded-full animate-spin mb-6" />
          <p className="text-[#00FFD1] font-mono text-xs uppercase tracking-[0.3em] animate-pulse">
            Loading Neon Golf Clash…
          </p>
        </div>
      )}

      {/* Back to lobby — top-24 keeps it clear of the game's own top-left HUD */}
      {/* Pug-style pause menu — THE exit path for this round (the game
          inside the iframe posts results only, never an exit message, so
          this overlay is the only way out mid-round). Routed through the
          guard: mid-match it asks first and forfeits, after the whistle it
          just leaves. */}
      <GamePauseMenu onExit={() => requestExit(onExit)} exitLabel="Quit to lobby" />

      <iframe
        ref={frameRef}
        src={GAME_SRC}
        title="Neon Golf Clash"
        className="w-full h-full border-0 block"
        // The match is already running when this fires (see ?autostart=1), and
        // the game reads the keyboard off its OWN window — without handing it
        // focus the player's first keypresses would go to the arcade shell.
        // This is also the round's start whistle out here: stamp it for the
        // forfeit duration and arm the once-per-round XP guard.
        onLoad={() => {
          setLoaded(true);
          roundStartedAtRef.current = Date.now();
          armRound();
          frameRef.current?.focus();
        }}
        allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope"
      />

      {/* Forfeit-on-exit: the defeat screen the confirm dialog promised — the
          iframe shows nothing of its own for a match we abandoned. */}
      {forfeited && (
        <ResultsScreen
          won={false}
          stake={0}
          winnings={0}
          moneyless
          gameMode="Golf Clash"
          note="You left the round — counted as a loss"
          onRematch={leaveNow}
          onExit={leaveNow}
        />
      )}

      {/* Practice-shaped level progression for the forfeit loss, chained after
          the results screen; its close cues the deferred navigation. */}
      <PostGameProgression
        progression={practiceProgression}
        onDone={() => {
          clearPracticeProgression();
          finishExit();
        }}
      />

      {/* Mid-match "are you sure? leaving forfeits" dialog (z-[130]). */}
      {confirmDialog}
    </div>
  );
};

export default NeonGolfClash;
