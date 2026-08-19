import React, { useEffect, useRef } from 'react';
import GameBackButton from '../common/GameBackButton';
import { reportGameSession } from '../../lib/sessionXp';
import type { PugShooterMatchConfig } from './PugShooterLobby';

interface PugShooterPlayProps {
  /** The match the lobby configured — becomes the iframe's query string. */
  config: PugShooterMatchConfig;
  /** Return to the lobby (unmounts the iframe, stopping the game). */
  onExit: () => void;
}

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
 * match on the query string, and its "Quit to lobby" posts
 * `neon-pug-shooter:exit`, which we translate into onExit here.
 *
 * It also posts `neon-pug-shooter:result` when a match ends, which is how a
 * game the server never sees still earns XP — see lib/sessionXp.ts for why
 * that has to come from the client and what stops it being abused.
 */
export default function PugShooterPlay({ config, onExit }: PugShooterPlayProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);

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

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Same-origin only: the iframe is served from our own /public, so a
      // message from anywhere else is not this game talking.
      if (event.origin !== window.location.origin) return;

      if (event.data?.type === 'neon-pug-shooter:exit') {
        onExit();
        return;
      }

      if (event.data?.type === 'neon-pug-shooter:result') {
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
  }, [onExit, config.mode]);

  const src = `/neon-pug-shooter/index.html?mode=${config.mode}&map=${config.map}&difficulty=${config.difficulty}`;

  return (
    <div className="absolute inset-0 w-full h-full bg-[#050d1c]">
      <iframe
        ref={frameRef}
        src={src}
        title="Neon Pug Shooter"
        className="block w-full h-full border-0"
        allow="pointer-lock; fullscreen; gamepad; autoplay; accelerometer; gyroscope"
      />
      {/* Back-to-lobby overlay (press Esc first if the pointer is locked). */}
      <GameBackButton onClick={onExit} positionClassName="absolute top-24 left-6 z-30" />
    </div>
  );
}
