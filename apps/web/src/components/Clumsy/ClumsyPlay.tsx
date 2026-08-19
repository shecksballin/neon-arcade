import React, { useEffect, useMemo, useRef } from 'react';
import GameBackButton from '../common/GameBackButton';
import { reportGameSession } from '../../lib/sessionXp';

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

  /**
   * PROGRESSION. The round runs entirely inside the iframe, so the only way
   * this game can pay XP like every other game is for it to tell us how the
   * round went — `neon-clumsy:result`, posted once when the end screen shows.
   * See lib/sessionXp.ts for what the server does with an unverifiable
   * result (short version: clamps it, caps it daily, never touches RP).
   */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Same-origin only — the game is served from our own /public.
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'neon-clumsy:result') return;

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
  }, []);

  const src = useMemo(() => {
    const params = new URLSearchParams({ autostart: '1' });
    const name = playerName?.trim();
    if (name) params.set('name', name.slice(0, 14));
    return `/neon-clumsy-game/index.html?${params.toString()}`;
  }, [playerName]);

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
      {/* Back-to-lobby overlay (press Esc first if the pointer is locked). */}
      <GameBackButton onClick={onExit} positionClassName="absolute top-24 left-6 z-30" />
    </div>
  );
}
