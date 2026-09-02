import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getLevelInfo } from '@neon/types';
import GameBackButton from '../common/GameBackButton';
import { FullscreenButton } from '../common/fullscreen';
import { PerfHud } from '../common/PerfHud';
import { reportGameSession } from '../../lib/sessionXp';
import { usePracticeXp } from '../../hooks/usePracticeXp';
import { useGuardedExit } from '../common/exitGuard';
import { PostGameProgression } from '../common/PostGameProgression';
import { ResultsScreen } from '../NeonBucks/ResultsScreen';
import { hasAuthToken } from '../social/usePresence';
import type { XpSummary } from '../../lib/api';
import type { PugShooterMatchConfig } from './PugShooterLobby';

interface PugShooterPlayProps {
  /** The match the lobby configured — becomes the iframe's query string. */
  config: PugShooterMatchConfig;
  /** Return to the lobby (unmounts the iframe, stopping the game). */
  onExit: () => void;
  /** Arcade identity — name rides into the iframe for the killcam strip. */
  profile: { name: string; avatarUrl: string } | null;
}

/** ResultsScreen wants a human "Game Mode" line, not the queue keys. */
const MODE_LABELS: Record<PugShooterMatchConfig['mode'], string> = {
  ffa: 'Free-for-all',
  duel: 'Duel',
  duo: 'Duo',
};

/**
 * Hosts the self-contained Neon Pug Shooter (vanilla three.js + Rapier),
 * served statically from `public/neon-pug-shooter/`. Kept in an <iframe> so
 * the game runs in full isolation with its own importmap, HUD DOM, WASM
 * physics and render loop — and tears down cleanly when this unmounts.
 *
 * This module is loaded via React.lazy (see PugShooterGame), so nothing of
 * the game — code or the ~60MB of Mixamo/map assets it streams — is touched
 * until a player actually starts a match.
 *
 * The game has no main menu of its own any more: it boots straight into the
 * match on the query string. Its messages back out:
 *   round-start  — a match went live (boot AND in-iframe rematch), arming
 *                  the exit guard below,
 *   quit-request — the pause menu's Quit while a match is LIVE. Leaving a
 *                  live round is a forfeit, and that decision (confirm
 *                  dialog → loss report → results → progression) is the
 *                  arcade's, so the game only raises its hand,
 *   exit         — Quit after the whistle (results screen), free as ever,
 *   result       — how a game the server never sees still earns XP — see
 *                  lib/sessionXp.ts for why that has to come from the
 *                  client and what stops it being abused.
 */
export default function PugShooterPlay({ config, onExit, profile }: PugShooterPlayProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const queryClient = useQueryClient();

  /**
   * The boot URL, FROZEN on first render: changing an iframe's src reloads
   * the document, which would restart the match mid-round — so name/level
   * must never ride a re-render (profile refresh, xp cache warming) in.
   * Identity for the killcam strip: the trimmed name (Clumsy's 14-char
   * convention) and the REAL level, read synchronously from the ['stats',
   * 'xp'] cache the lobby's LobbyLevelStrip warmed and derived through the
   * one true curve (getLevelInfo — never trust a stored level). Signed out,
   * or before the cache has data, the params are simply omitted and the
   * game falls back to 'you' / a dashed level.
   */
  const [src] = useState(() => {
    const params = new URLSearchParams({
      mode: config.mode,
      map: config.map,
      difficulty: config.difficulty,
    });
    const name = profile?.name?.trim().slice(0, 14);
    if (name) params.set('name', name);
    if (profile) {
      const xp = queryClient.getQueryData<XpSummary>(['stats', 'xp']);
      if (xp) params.set('level', String(getLevelInfo(xp.xp).level));
    }
    return `/neon-pug-shooter/index.html?${params.toString()}`;
  });

  /**
   * DETERMINISTIC GPU TEARDOWN. Unmounting only DETACHES the iframe — the
   * game inside registers no unload handler and never loses its WebGL
   * context, so its whole realm (three.js scene, ~60MB of decoded assets,
   * a LIVE GPU context) lingered in a detached document until the browser
   * got around to GC. Stack a couple of those and the landing page's own
   * WebGL (fluid cursor + blob) crawls while the WebGL-free library stays
   * fast — exactly the reported symptom. Navigating the frame to
   * about:blank in cleanup forces the inner document to unload NOW.
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

  // Round lifecycle, as told by the iframe's messages. Refs mirror the state
  // for the listener and the forfeit path, which must read current values
  // without re-subscribing.
  const [roundLive, setRoundLive] = useState(false);
  const roundLiveRef = useRef(false);
  /**
   * Has the game EVER announced a round? Exit normally lives inside the
   * iframe (Menu → Quit), which is unreachable if the frame never gets
   * that far — a failed asset fetch, a lost WebGL context, a thrown boot.
   * Until the first round-start there is no in-game menu to reach, so the
   * parent keeps a way out; after it, the iframe owns the affordance and
   * this disappears rather than double up on it.
   */
  const [bootedOnce, setBootedOnce] = useState(false);
  const [forfeited, setForfeited] = useState(false);
  const forfeitedRef = useRef(false);
  const roundStartedAtRef = useRef<number | null>(null);

  // Practice-shaped XP for the forfeit loss: same metered self-reported path
  // as the game's own result messages, but a DIFFERENT dedupe keyspace
  // (pugshooter:practice:<uuid> vs pugshooter:<roundId>) — which is exactly
  // why the listener below must ignore any later result message once
  // forfeited, or the round would pay twice.
  const { practiceProgression, armRound, reportRound, clearPracticeProgression } =
    usePracticeXp('pugshooter');

  const {
    requestExit,
    finishExit,
    exitPending,
    confirmDialog,
  } = useGuardedExit({
    // Live between the iframe's round-start and its result message (an
    // in-iframe rematch re-arms via a fresh round-start). Never during the
    // loading screen, never on a finished results screen, and never twice.
    active: roundLive && !forfeited,
    onForfeit: () => {
      // Flip this round into ended-as-a-loss on OUR side. The iframe is
      // sitting paused behind the overlays (its quit-request leaves the
      // match frozen), so the loss below is the only settlement there can
      // be — the listener drops anything it says from here on regardless.
      forfeitedRef.current = true;
      setForfeited(true);
      // Tell the score-duel layer this round no longer counts: the iframe
      // keeps simulating under the results overlay and would otherwise post
      // a real score — letting a player forfeit and still win the verdict.
      window.dispatchEvent(new CustomEvent('neon:duel-forfeit'));
      roundLiveRef.current = false;
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
        'Leaving now ends the match as a loss. Your results will play before you go.',
      confirmLabel: 'Leave & forfeit',
    },
  });

  // Signed out, the forfeit report goes nowhere and no progression will ever
  // come — cue the deferred navigation instead of sitting out the guard's
  // 12s fallback. finishExit still holds the results screen its minimum beat.
  useEffect(() => {
    if (exitPending && forfeited && !hasAuthToken()) finishExit();
  }, [exitPending, forfeited, finishExit]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Same-origin only: the iframe is served from our own /public, so a
      // message from anywhere else is not this game talking.
      if (event.origin !== window.location.origin) return;
      const type = event.data?.type;

      if (type === 'neon-pug-shooter:round-start') {
        // A match went live — at boot, and again on every in-iframe
        // rematch (which would otherwise be invisible out here, leaving
        // the exit guard disarmed for round two).
        roundLiveRef.current = true;
        setRoundLive(true);
        setBootedOnce(true);
        roundStartedAtRef.current = Date.now();
        armRound();
        return;
      }

      if (type === 'neon-pug-shooter:quit-request') {
        // Pause-menu Quit during a live round: open the confirm; on
        // confirm the forfeit above runs, then results → progression →
        // the deferred onExit.
        requestExit(onExit);
        return;
      }

      if (type === 'neon-pug-shooter:exit') {
        // Quit after the whistle. Routed through the guard anyway: with no
        // live round it runs immediately, exactly as before.
        requestExit(onExit);
        return;
      }

      if (type === 'neon-pug-shooter:result') {
        // Once forfeited, the round is already settled as a loss — a match
        // the iframe finishes on its own underneath the results overlay
        // must not ALSO pay out (double XP; see the dedupe note above).
        if (forfeitedRef.current) return;
        roundLiveRef.current = false;
        setRoundLive(false);
        const r = event.data;
        void reportGameSession(
          {
            gameKey: 'pugshooter',
            // The lobby's mode vocabulary ('duel'/'duo'/'ffa'/…) is not the
            // stats one; duels are the 1v1 shape, everything else is a
            // free-for-all against bots.
            mode: config.mode === 'duel' ? '1v1' : 'ffa',
            result: r.won ? 'win' : 'loss',
            kills: r.kills,
            deaths: r.deaths,
            score: r.score,
            placement: r.placement ?? null,
            durationMs: r.durationMs ?? null,
          },
          // One award per match: the game stamps each round it starts.
          `pugshooter:${r.roundId ?? r.durationMs ?? ''}`
        );
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onExit, config.mode, requestExit, armRound]);

  // Both results-screen buttons leave: the forfeited round's iframe has no
  // inbound message channel at all, so there is no way to ask it for a fresh
  // round — a real "Rematch" cannot be honored here. While the exit is
  // pending, requestExit runs the navigation immediately (the player is
  // telling us to hurry up).
  const leaveNow = useCallback(() => requestExit(onExit), [requestExit, onExit]);

  return (
    <div className="absolute inset-0 w-full h-full bg-[#050d1c]">
      <iframe
        ref={frameRef}
        src={src}
        title="Neon Pug Shooter"
        className="block w-full h-full border-0"
        allow="pointer-lock; fullscreen; gamepad; autoplay; accelerometer; gyroscope"
      />
      {/* Fullscreen from the parent frame, bottom-right like every game —
          offset left of the iframe's own Menu pill (#hud-bottom-right at
          right:32px). The game also forwards its 'f' presses out via
          postMessage (see common/fullscreen.tsx), so key and button match.
          Exit lives in the game's own Menu → Quit to lobby. */}
      <FullscreenButton positionClassName="absolute bottom-8 right-36 z-30" />

      {/* FPS/ping, slotted just LEFT of the iframe's 256px-wide top-right
          leaderboard card (#hud-top-right at top:32 right:32). top-28 drops
          it below the centered MATCH zone-card's band (~30-100px tall) so a
          narrow window can't slide the card into it. */}
      <PerfHud positionClassName="absolute top-28 right-[19rem] z-30" />

      {/* Escape hatch for a frame that never reaches its first round (see
          bootedOnce). Guarded like every other exit, so if a round somehow
          IS live it still confirms rather than silently abandoning it. */}
      {!bootedOnce && (
        <GameBackButton
          onClick={leaveNow}
          title="Back to lobby"
          positionClassName="absolute top-24 left-24 z-30"
        />
      )}

      {/* Forfeit-on-exit: the defeat screen the confirm dialog promised —
          the iframe never shows its own results for an abandoned round. */}
      {forfeited && (
        <ResultsScreen
          won={false}
          stake={0}
          winnings={0}
          moneyless
          gameMode={MODE_LABELS[config.mode]}
          note="You left the match — counted as a loss"
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

      {/* Mid-match "are you sure? leaving forfeits" dialog. */}
      {confirmDialog}
    </div>
  );
}
