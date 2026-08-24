import { Canvas } from '@react-three/fiber';
import { AnimatePresence } from 'motion/react';
import { Suspense, useEffect } from 'react';
import { Scene } from './scene/Scene';
import { useGame } from './store';
import { Hud } from './ui/Hud';
import { LoadingOverlay } from './ui/LoadingOverlay';
import { MenuScreen } from './ui/MenuScreen';
import { PauseMenu } from './ui/PauseMenu';
import { ResultsScreen } from './ui/ResultsScreen';

export default function PenaltyCore() {
  const screen = useGame((s) => s.screen);
  const phase = useGame((s) => s.phase);
  const paused = useGame((s) => s.paused);
  const mode = useGame((s) => s.mode);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const g = useGame.getState();
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        g.togglePause();
        return;
      }
      if (g.screen !== 'game' || g.paused) return;
      if (g.phase === 'aim') {
        if (k === 'a') g.strikerKick('left');
        else if (k === 'w') g.strikerKick('middle');
        else if (k === 'd') g.strikerKick('right');
      } else if (g.phase === 'guard') {
        // keeper keys are in the keeper's own frame; store dirs live in the
        // striker's frame, so left and right swap here
        if (k === 'a') g.setGuess('right');
        else if (k === 'd') g.setGuess('left');
        else if (k === 'w' || k === 's') g.setGuess('middle');
      }
    };
    window.addEventListener('keydown', onKey);
    if (import.meta.env.DEV) (window as unknown as { __game: unknown }).__game = useGame;
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative w-full h-full bg-[#081616] overflow-hidden select-none">
      <Canvas
        shadows
        dpr={[1, 1.75]}
        camera={{ fov: 66, near: 0.1, far: 420, position: [14, 7, 26] }}
        // the stadium is cut back behind the striker with a clipping plane, and
        // per-material planes only take effect once this is on
        onCreated={({ gl }) => {
          gl.localClippingEnabled = true;
        }}
      >
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </Canvas>

      <AnimatePresence>{screen === 'menu' && <MenuScreen />}</AnimatePresence>
      {screen === 'game' && (
        <>
          <Hud />
          <AnimatePresence>{paused && <PauseMenu />}</AnimatePresence>
          {/* Online endings use the arcade's shared results + progression
              screens (see NeonKickoffGame) — the practice board here would
              show a local best-runs table that online never writes. */}
          <AnimatePresence>{phase === 'over' && mode === 'practice' && <ResultsScreen />}</AnimatePresence>
        </>
      )}
      <LoadingOverlay />
    </div>
  );
}
