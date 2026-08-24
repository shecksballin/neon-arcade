import { motion } from 'motion/react';
import { RefreshCw, ShieldCheck, Target, Trophy } from 'lucide-react';
import { goals } from '../shootout';
import { useGame } from '../store';
import { ScorePips } from './ScorePips';

export function ResultsScreen() {
  const shootout = useGame((s) => s.shootout);
  const stats = useGame((s) => s.stats);
  const startMatch = useGame((s) => s.startMatch);
  const quitToMenu = useGame((s) => s.quitToMenu);

  const won = shootout.winner === 'player';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/85 backdrop-blur-xl px-6 pointer-events-auto overflow-y-auto"
    >
      <Trophy className={`w-14 h-14 mb-4 ${won ? 'text-[#00FFD1]' : 'text-[#FF0080]'} animate-pulse`} />
      <h2
        className={`text-5xl md:text-7xl font-black italic uppercase tracking-tighter mb-1 text-center ${
          won
            ? 'text-[#00FFD1] drop-shadow-[0_0_60px_rgba(0,255,209,0.45)]'
            : 'text-[#FF0080] drop-shadow-[0_0_60px_rgba(255,0,128,0.45)]'
        }`}
      >
        {won ? 'Victory' : 'Defeat'}
      </h2>
      <p className="text-white/50 font-mono text-[11px] uppercase tracking-[0.4em] mb-6 text-center">
        {won ? 'You held your nerve from the spot' : 'The AI read you from the spot'}
      </p>

      <div className="bg-[#040b0b] border border-[#00FFD1]/30 rounded-xl p-6 w-full max-w-md mb-6">
        <div className="flex items-center justify-center gap-6 mb-5">
          <span className="text-5xl font-black italic text-white tracking-tighter">
            {goals(shootout, 'player')}
          </span>
          <span className="text-white/30 font-mono text-xs uppercase tracking-widest">final</span>
          <span className="text-5xl font-black italic text-white tracking-tighter">
            {goals(shootout, 'ai')}
          </span>
        </div>
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <span className="w-9 text-[10px] font-mono uppercase tracking-widest text-[#00FFD1]">You</span>
            <ScorePips shootout={shootout} side="player" active={false} big />
          </div>
          <div className="flex items-center gap-4">
            <span className="w-9 text-[10px] font-mono uppercase tracking-widest text-[#FF0080]">AI</span>
            <ScorePips shootout={shootout} side="ai" active={false} big />
          </div>
        </div>
        <div className="flex gap-2 mt-5 pt-4 border-t border-[#00FFD1]/10">
          <div className="flex-1 flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2">
            <Target className="w-4 h-4 text-[#2bff8f]" />
            <span className="text-[10px] font-mono uppercase tracking-widest text-white/50">Perfect</span>
            <span className="ml-auto font-black italic text-white">{stats.perfect}</span>
          </div>
          <div className="flex-1 flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2">
            <ShieldCheck className="w-4 h-4 text-[#00FFD1]" />
            <span className="text-[10px] font-mono uppercase tracking-widest text-white/50">Saves</span>
            <span className="ml-auto font-black italic text-white">{stats.saves}</span>
          </div>
        </div>
      </div>

      <div className="mb-8">
      </div>

      <div className="flex gap-3 pb-8">
        <button
          onClick={startMatch}
          className="px-8 py-4 rounded-2xl bg-[#00FFD1] text-[#081616] font-black uppercase italic tracking-tighter hover:scale-105 transition-all flex items-center gap-2 cursor-pointer"
        >
          <RefreshCw className="w-5 h-5" /> Rematch
        </button>
        <button
          onClick={quitToMenu}
          className="px-8 py-4 rounded-2xl bg-white/5 border border-white/10 text-white/70 font-black uppercase italic tracking-tighter hover:bg-white/10 transition-all cursor-pointer"
        >
          Main Menu
        </button>
      </div>
    </motion.div>
  );
}
