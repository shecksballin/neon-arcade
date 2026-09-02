import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GamePauseMenu } from '../common/GamePauseMenu';
import { FullscreenButton } from '../common/fullscreen';
import { PerfHud } from '../common/PerfHud';
import { reportGameSession } from '../../lib/sessionXp';
import { usePracticeXp } from '../../hooks/usePracticeXp';
import { useGuardedExit } from '../common/exitGuard';
import { PostGameProgression } from '../common/PostGameProgression';
import { ResultsScreen } from '../NeonBucks/ResultsScreen';
import { hasAuthToken } from '../social/usePresence';

interface ClumsyPlayProps {
  /** Return to the Clumsy lobby (unmounts the iframe, stopping the game). */
  onExit: () => void;
  /** Arcade profile name — becomes the in-game nickname (feed + end screen). */
  playerName?: string | null;
}

/**
 * Hosts the self-contained Neon Clumsy game (vanilla three.js + Rapier),
 * served statically from `public/neon-clumsy-game/`. Kept in an <iframe> so
 * the game runs in full isolation with its own importmap, HUD DOM, WASM
 * physics and render loop — and tears down cleanly when this unmounts.
 *
 * This module is loaded via React.lazy (see ClumsyGame), so the ~4MB three +
 * Rapier vendor bundle and the character glb only download when a player
 * actually starts a match — keeping the arcade's initial load fast.
 *
 * `?autostart=1` SKIPS THE GAME'S OWN PLAY MENU. This component only mounts
 * once the player has already committed to a round — they pressed PRACTICE,
 * their WAGER MATCH queue found an opponent, or a PRIVATE WAGER lobby finished
 * readying up — so the in-iframe PLAY button (and its nickname prompt) asked
 * for a decision that had already been made. `&name=` supplies the nickname
 * the arcade already knows.
 *
 * What the game says back over postMessage:
 *   round-start — a round went live (boot AND the in-iframe PLAY AGAIN),
 *                 arming the exit guard below,
 *   result      — how a game the server never sees still earns XP.
 * There is no exit message: Clumsy has no quit of its own, so the pause menu
 * here is the only way out of a live round — which makes it the only thing
 * the forfeit guard has to cover.
 */
export default function ClumsyPlay({ onExit, playerName }: ClumsyPlayProps) {
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

  // Round lifecycle, as told by the iframe. `forfeited` also mirrors into a
  // ref: the message listener is subscribed once and must read the CURRENT
  // value, not the one its closure was born with.
  const [roundLive, setRoundLive] = useState(false);
  const [forfeited, setForfeited] = useState(false);
  const forfeitedRef = useRef(false);
  const roundStartedAtRef = useRef<number | null>(null);

  /**
   * Practice-shaped XP for a forfeit loss: the same metered self-reported
   * path the game's own result message takes, but a DIFFERENT dedupe
   * keyspace (`clumsy:practice:<uuid>` vs `clumsy:<roundId>`) — which is
   * exactly why the listener below drops any result that arrives after a
   * forfeit. Two keyspaces cannot dedupe each other, so the round would
   * otherwise pay twice. Practice never touches rank, by construction of
   * usePracticeXp: leaving costs a level's worth of progress, not RP.
   */
  const { practiceProgression, armRound, reportRound, clearPracticeProgression } =
    usePracticeXp('clumsy');

  const { requestExit, finishExit, exitPending, confirmDialog } = useGuardedExit({
    // Live between the iframe's round-start and its result — never during the
    // loading screen, never on the end screen the game shows once the player
    // is out (their round is already settled by then), and never twice.
    active: roundLive && !forfeited,
    onForfeit: () => {
      // Flip this round into ended-as-a-loss on OUR side. The iframe keeps
      // simulating underneath the overlays, but the loss below is the one
      // settlement — the listener drops anything it says from here on.
      forfeitedRef.current = true;
      setForfeited(true);
      // Tell the score-duel layer this round no longer counts: the iframe
      // keeps simulating under the results overlay and would otherwise post
      // a real score — letting a player forfeit and still win the verdict.
      window.dispatchEvent(new CustomEvent('neon:duel-forfeit'));
      setRoundLive(false);
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
        'Leaving now ends the round as a loss. Your results will play before you go.',
      confirmLabel: 'Leave & forfeit',
    },
  });

  // Signed out, the forfeit report goes nowhere and no progression will ever
  // come — cue the deferred navigation instead of sitting out the guard's
  // 12s fallback. finishExit still holds the results screen its minimum beat.
  useEffect(() => {
    if (exitPending && forfeited && !hasAuthToken()) finishExit();
  }, [exitPending, forfeited, finishExit]);

  /**
   * PROGRESSION. The round runs entirely inside the iframe, so the only way
   * this game can pay XP like every other game is for it to tell us how the
   * round went — `neon-clumsy:result`, posted once when the end screen shows.
   * See lib/sessionXp.ts for what the server does with an unverifiable
   * result (short version: clamps it, caps it daily, never touches RP).
   */
  // The message listener binds once, before leaveNow exists — read through
  // a ref so the exit message always runs the CURRENT guarded-exit closure.
  const leaveNowRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Same-origin only — the game is served from our own /public.
      if (event.origin !== window.location.origin) return;
      const type = event.data?.type;

      if (type === 'neon-clumsy:exit') {
        // The end screen's EXIT button. The round is already over when it
        // shows, so the guard is inactive and this leaves immediately —
        // same path as the pause menu's quit.
        leaveNowRef.current();
        return;
      }

      if (type === 'neon-clumsy:round-start') {
        // A round went live: at boot, and again on every in-iframe PLAY
        // AGAIN (invisible out here otherwise, leaving the guard disarmed
        // for round two).
        setRoundLive(true);
        roundStartedAtRef.current = Date.now();
        armRound();
        return;
      }

      if (type !== 'neon-clumsy:result') return;
      // Once forfeited the round is already settled as a loss — the match
      // the iframe finishes on its own underneath the results overlay must
      // not ALSO pay out (double XP; see the dedupe note above).
      if (forfeitedRef.current) return;
      setRoundLive(false);

      const r = event.data;
      void reportGameSession(
        {
          gameKey: 'clumsy',
          // A battle-royale round against bots: many players, one winner.
          mode: 'ffa',
          result: r.won ? 'win' : 'loss',
          // Tiles claimed is the game's own score; bumps are not kills (there
          // is no kill in Clumsy), so kills/deaths stay at zero.
          score: r.tiles,
          placement: r.place ?? null,
          durationMs: r.durationMs ?? null,
        },
        `clumsy:${r.roundId ?? r.durationMs ?? ''}`
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [armRound]);

  const src = useMemo(() => {
    const params = new URLSearchParams({ autostart: '1' });
    const name = playerName?.trim();
    if (name) params.set('name', name.slice(0, 14));
    return `/neon-clumsy-game/index.html?${params.toString()}`;
  }, [playerName]);

  // Both results-screen buttons leave: the forfeited round's iframe is still
  // running its own match underneath and has no inbound channel to restart,
  // so a real "Rematch" cannot be honored here — and while the exit is
  // pending, requestExit runs the navigation immediately (the player is
  // telling us to hurry up).
  const leaveNow = useCallback(() => requestExit(onExit), [requestExit, onExit]);
  leaveNowRef.current = leaveNow;

  return (
    <div className="absolute inset-0 w-full h-full bg-[#0d0824]">
      <iframe
        ref={frameRef}
        src={src}
        title="Neon Clumsy"
        className="block w-full h-full border-0"
        // The round starts on its own now, and the game reads keyboard/mouse
        // off its OWN window — without handing it focus the player's first
        // inputs would go to the arcade shell instead.
        onLoad={() => frameRef.current?.focus()}
        allow="pointer-lock; fullscreen; gamepad; autoplay; accelerometer; gyroscope"
      />
      {/* Fullscreen from the parent frame, bottom-right like every game —
          offset left of the iframe's own SOUND pill (#muteBtn at right:32px).
          The game also forwards its 'f' presses out via postMessage (see
          common/fullscreen.tsx), so key and button match. Desktop-only by
          construction (FullscreenButton returns null on coarse pointers), so
          it never collides with the touch Menu pill in this corner. */}
      <FullscreenButton positionClassName="absolute bottom-8 right-40 z-30" />

      {/* FPS/ping, slotted just LEFT of the iframe's 256px-wide top-right
          leaderboard card (#hudTopRight at top:32 right:32). top-24 drops it
          below the centered PLAYERS LEFT chip's band (~28-84px tall) so a
          narrow window can't slide the chip into it. */}
      <PerfHud positionClassName="absolute top-24 right-[19rem] z-30" />

      {/* Pug-style pause menu — THE exit path for this round (the game inside
          the iframe posts results only, never an exit message, so this
          overlay is the only way out mid-round; press Esc first if the
          pointer is locked). Quit goes through the guard: mid-round it asks
          first and forfeits, after the whistle it just leaves. */}
      <GamePauseMenu onExit={leaveNow} exitLabel="Quit to lobby" />

      {/* Forfeit-on-exit: the defeat screen the confirm dialog promised —
          the iframe never shows its own results for an abandoned round. */}
      {forfeited && (
        <ResultsScreen
          won={false}
          stake={0}
          winnings={0}
          moneyless
          gameMode="Clumsy"
          note="You left the round — counted as a loss"
          onRematch={leaveNow}
          onExit={leaveNow}
        />
      )}

      {/* Practice-shaped level progression for the forfeit loss, chained
          after the results screen; its close cues the deferred navigation. */}
      <PostGameProgression
        progression={practiceProgression}
        onDone={() => {
          clearPracticeProgression();
          finishExit();
        }}
      />

      {/* Mid-round "are you sure? leaving forfeits" dialog. */}
      {confirmDialog}
    </div>
  );
}
