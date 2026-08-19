import { useEffect, useRef, useState } from 'react';
import GameBackButton from '../common/GameBackButton';
import { reportGameSession } from '../../lib/sessionXp';

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
      if (event.data?.type !== 'neon-golf:result') return;

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
  }, []);

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
      <GameBackButton onClick={onExit} positionClassName="absolute top-24 left-6 z-30" />

      <iframe
        ref={frameRef}
        src={GAME_SRC}
        title="Neon Golf Clash"
        className="w-full h-full border-0 block"
        // The match is already running when this fires (see ?autostart=1), and
        // the game reads the keyboard off its OWN window — without handing it
        // focus the player's first keypresses would go to the arcade shell.
        onLoad={() => {
          setLoaded(true);
          frameRef.current?.focus();
        }}
        allow="autoplay; fullscreen; gamepad; accelerometer; gyroscope"
      />
    </div>
  );
};

export default NeonGolfClash;
