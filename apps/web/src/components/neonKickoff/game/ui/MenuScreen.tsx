import { motion } from 'motion/react';
import { Bot, Goal, Users, Wifi } from 'lucide-react';
import { useGame } from '../store';

export function MenuScreen() {
  const startMatch = useGame((s) => s.startMatch);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-md pointer-events-auto overflow-y-auto"
    >
      <div className="max-w-lg w-full p-8 text-center">
        <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="mb-8">
          <div className="w-20 h-20 bg-[#00FFD1]/10 rounded-3xl border border-[#00FFD1]/20 flex items-center justify-center mx-auto mb-6 shadow-[0_0_50px_rgba(0,255,209,0.2)]">
            <Goal className="w-10 h-10 text-[#00FFD1]" />
          </div>
          <h1 className="text-5xl md:text-6xl font-black italic text-white uppercase tracking-tighter mb-2">
            Neon <span className="text-[#00FFD1]">Kickoff</span>
          </h1>
          <p className="text-[#00FFD1]/60 font-mono text-sm tracking-[0.25em] uppercase">
            Penalty Shootout Protocol
          </p>
        </motion.div>

        {/* Mode selection lives in the ARCADE lobby now (Practice /
            Online / Private Wager) - the three mode cards that sat here
            (VS AI + two coming-soon) were removed with it. */}

        <button
          onClick={startMatch}
          className="w-full py-5 bg-[#00FFD1] text-[#00382c] font-black uppercase tracking-[0.3em] rounded-2xl hover:scale-105 active:scale-95 transition-all shadow-[0_0_40px_rgba(0,255,209,0.4)] cursor-pointer mb-6"
        >
          Start Shootout
        </button>

        <div className="grid grid-cols-2 gap-3 text-left mb-6">
          <div className="p-4 rounded-xl bg-white/5 border border-white/5">
            <p className="text-[10px] text-[#00FFD1]/60 uppercase font-mono tracking-widest mb-1">You strike</p>
            <p className="text-white font-bold text-sm">A top left · W middle · D top right</p>
            <p className="text-white/40 text-xs mt-1">
              Hit the key when the ring under the ball pulses <span className="text-[#2bff8f]">green</span>.
              Stall and it speeds up — <span className="text-[#ff5a5a]">red skies it over the bar</span>.
            </p>
          </div>
          <div className="p-4 rounded-xl bg-white/5 border border-white/5">
            <p className="text-[10px] text-[#FF0080]/60 uppercase font-mono tracking-widest mb-1">You keep</p>
            <p className="text-white font-bold text-sm">A dive left · D dive right</p>
            <p className="text-white/40 text-xs mt-1">
              Touch nothing to hold the middle. Best of five, then sudden death — just like the real thing.
            </p>
          </div>
        </div>

        <div className="flex justify-center pb-8">
        </div>
      </div>
    </motion.div>
  );
}
