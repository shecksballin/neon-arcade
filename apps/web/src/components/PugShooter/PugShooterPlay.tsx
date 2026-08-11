import React, { useEffect } from 'react';
import GameBackButton from '../common/GameBackButton';
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
 */
export default function PugShooterPlay({ config, onExit }: PugShooterPlayProps) {
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data?.type === 'neon-pug-shooter:exit') {
        onExit();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onExit]);

  const src = `/neon-pug-shooter/index.html?mode=${config.mode}&map=${config.map}&difficulty=${config.difficulty}`;

  return (
    <div className="absolute inset-0 w-full h-full bg-[#050d1c]">
      <iframe
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
