import { useProgress } from '@react-three/drei';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';

/** teal loading bar while the stadium + squad FBX parse (~50MB of assets) */
export function LoadingOverlay() {
  const { active, progress } = useProgress();
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!active && progress >= 100) {
      const t = setTimeout(() => setDone(true), 350);
      return () => clearTimeout(t);
    }
  }, [active, progress]);

  return (
    <AnimatePresence>
      {!done && (
        <motion.div
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          className="absolute inset-0 z-[200] flex flex-col items-center justify-center bg-[#050d11]"
        >
          <p className="text-4xl font-black italic uppercase tracking-tighter text-white mb-1">
            Neon <span className="text-[#00FFD1]">Kickoff</span>
          </p>
          <p className="text-[#00FFD1]/50 font-mono text-[10px] uppercase tracking-[0.4em] mb-8">
            Flooding the stadium lights
          </p>
          <div className="w-72 h-1.5 bg-white/5 rounded-full overflow-hidden border border-white/5">
            <div
              className="h-full bg-[#00FFD1] shadow-[0_0_15px_rgba(0,255,209,0.7)] transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-3 font-mono text-[10px] text-white/30 uppercase tracking-widest">
            {Math.round(progress)}%
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
