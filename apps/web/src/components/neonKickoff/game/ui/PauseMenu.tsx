import { motion } from 'motion/react';
import { Pause } from 'lucide-react';
import { useGame } from '../store';
// Quit funnels through the arcade's exit guard: mid-shootout it confirms,
// forfeits, shows the defeat + progression, THEN leaves. See exitGuard.tsx.
import { navigateWithExitGuard } from '../../../common/exitGuard';
import { toggleAppFullscreen, useIsFullscreen } from '../../../common/fullscreen';

export function PauseMenu() {
  const togglePause = useGame((s) => s.togglePause);
  const startMatch = useGame((s) => s.startMatch);
  const quitToMenu = useGame((s) => s.quitToMenu);
  const mode = useGame((s) => s.mode);
  const isFullscreen = useIsFullscreen();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md pointer-events-auto"
    >
      <div className="max-w-md w-full p-8 text-center">
        <div className="w-16 h-16 bg-[#00FFD1]/10 rounded-3xl border border-[#00FFD1]/20 flex items-center justify-center mx-auto mb-5 shadow-[0_0_50px_rgba(0,255,209,0.2)]">
          <Pause className="w-8 h-8 text-[#00FFD1]" />
        </div>
        <h2 className="text-5xl font-black italic text-white uppercase tracking-tighter mb-2">Paused</h2>
        <p className="text-[#00FFD1]/60 font-mono text-xs tracking-[0.3em] uppercase mb-8">
          The shootout is frozen
        </p>

        <div className="space-y-3">
          <button
            onClick={togglePause}
            className="w-full py-4 bg-[#00FFD1] text-[#00382c] font-black uppercase tracking-[0.3em] rounded-2xl hover:scale-105 active:scale-95 transition-all shadow-[0_0_40px_rgba(0,255,209,0.4)] cursor-pointer"
          >
            Resume
          </button>
          {/* PRACTICE ONLY: "restarting" an online shootout would silently
              reset the store to practice while the server match kept
              running — the seat would stall-sky every kick until forfeit. */}
          {mode === 'practice' && (
            <button
              onClick={startMatch}
              className="w-full py-4 border border-white/10 text-white font-black uppercase tracking-[0.3em] rounded-2xl hover:bg-white/5 transition-all cursor-pointer"
            >
              Restart Match
            </button>
          )}
          <button
            onClick={toggleAppFullscreen}
            className="w-full py-4 border border-white/10 text-white font-black uppercase tracking-[0.3em] rounded-2xl hover:bg-white/5 transition-all cursor-pointer"
          >
            {isFullscreen ? 'Exit Fullscreen (F)' : 'Fullscreen (F)'}
          </button>
          <button
            onClick={() => {
              const g = useGame.getState();
              // Online: quitting leaves the SHOOTOUT — land in the arcade
              // lobby (wrapper-injected). Practice: back to the game's menu.
              const leave =
                g.mode === 'online' && g.wrapperExit ? g.wrapperExit : quitToMenu;
              navigateWithExitGuard(leave);
            }}
            className="w-full py-4 border border-white/10 text-white/60 font-black uppercase tracking-[0.3em] rounded-2xl hover:bg-white/5 transition-all cursor-pointer"
          >
            Quit to Menu
          </button>
        </div>

        <div className="mt-10 grid grid-cols-2 gap-3 text-left">
          <div className="p-4 rounded-xl bg-white/5 border border-white/5">
            <p className="text-[10px] text-[#00FFD1]/60 uppercase font-mono tracking-widest mb-1">Striker</p>
            <p className="text-white font-bold text-sm">A / W / D — corners & middle, shoot on green</p>
          </div>
          <div className="p-4 rounded-xl bg-white/5 border border-white/5">
            <p className="text-[10px] text-[#FF0080]/60 uppercase font-mono tracking-widest mb-1">Keeper</p>
            <p className="text-white font-bold text-sm">A / D — dive, do nothing to stay middle</p>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
