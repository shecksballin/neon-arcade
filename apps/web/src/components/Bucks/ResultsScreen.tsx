import React from 'react';
import { motion } from 'motion/react';
import { Trophy, XCircle, RefreshCw, LogOut, Crosshair, HelpCircle } from 'lucide-react';

interface ResultsScreenProps {
  won: boolean;
  stake: number;
  winnings: number;
  gameMode: string;
  kills?: number;
  questionsRight?: number;
  onRematch: () => void;
  onExit: () => void;
}

export function ResultsScreen({
  won,
  stake,
  winnings,
  gameMode,
  kills,
  questionsRight,
  onRematch,
  onExit
}: ResultsScreenProps) {
  const isDraw = !won && winnings === stake; // for quiz ties or lms draw? Actually quiz returns same if draw? Let's just pass won.

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, backdropFilter: "blur(0px)" }}
      animate={{ opacity: 1, scale: 1, backdropFilter: "blur(12px)" }}
      exit={{ opacity: 0, scale: 0.95, backdropFilter: "blur(0px)" }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/90 px-6 rounded-2xl overflow-hidden"
    >
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2, duration: 0.5 }}
        className="flex flex-col items-center text-center w-full"
      >
        {(gameMode === 'Self-Wager' ? winnings >= 0 : (won || winnings > 0)) ? (
          <Trophy className="w-16 h-16 mb-6 animate-pulse text-[#00FFD1]" />
        ) : (
          <XCircle className="w-16 h-16 mb-6 text-red-500 animate-pulse" />
        )}
        
        <h2 className="text-4xl md:text-6xl font-black text-white italic uppercase tracking-tighter mb-4 w-full px-4">
          {gameMode === 'Self-Wager' ? (
            winnings > 0 ? "Profit!" : (winnings < 0 ? "Net Loss" : "Break-even")
          ) : (
            won ? "Victory!" : (winnings > 0 ? "Match Over" : "Defeat")
          )}
        </h2>

        <div className="bg-[#040b0b] border border-[#00FFD1]/30 rounded-xl p-6 w-full max-w-sm mb-8">
          <div className="space-y-4 font-mono text-sm uppercase tracking-widest text-[#00FFD1]/80">
            <div className="flex justify-between items-center border-b border-[#00FFD1]/10 pb-2">
              <span>Game Mode</span>
              <span className="text-white font-bold">{gameMode}</span>
            </div>
            
            <div className="flex justify-between items-center border-b border-[#00FFD1]/10 pb-2">
              <span>{gameMode === 'Self-Wager' ? 'Per-Question Stake' : 'Wagered'}</span>
              <span className="text-white font-bold flex items-center gap-0">
                <img src="/neon-bucks-icon.png" alt="NB" referrerPolicy="no-referrer" className="h-4.5 w-auto -mr-0.5" /> {stake}
              </span>
            </div>

            {kills !== undefined && (
              <div className="flex justify-between items-center border-b border-[#00FFD1]/10 pb-2">
                <span className="flex items-center gap-2"><Crosshair className="w-4 h-4" /> Kills</span>
                <span className="text-white font-bold">{kills}</span>
              </div>
            )}

            {questionsRight !== undefined && (
              <div className="flex justify-between items-center border-b border-[#00FFD1]/10 pb-2">
                <span className="flex items-center gap-2"><HelpCircle className="w-4 h-4" /> Correct</span>
                <span className="text-white font-bold">{questionsRight}</span>
              </div>
            )}

            <div className="flex justify-between items-center pt-2">
              <span>{gameMode === 'Self-Wager' ? 'Total Payout' : 'Payout'}</span>
              <span className={`text-xl font-black flex items-center gap-0 ${winnings > 0 ? "text-[#00FFD1]" : (winnings < 0 ? "text-red-500" : "text-white/50")}`}>
                {winnings > 0 ? '+' : ''} <img src="/neon-bucks-icon.png" alt="NB" referrerPolicy="no-referrer" className="h-6 w-auto -mr-1" /> {winnings}
              </span>
            </div>
          </div>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6 }}
        className="flex flex-col sm:flex-row gap-3 w-full max-w-sm"
      >
        <button
          onClick={onRematch}
          className="flex-1 px-4 py-3 bg-[#00FFD1] text-[#081616] font-black uppercase tracking-widest rounded-xl shadow-[0_0_30px_rgba(0,255,209,0.4)] hover:scale-105 transition-all flex items-center justify-center gap-2 group text-xs md:text-sm"
        >
          <RefreshCw className="w-5 h-5 group-hover:rotate-180 transition-transform duration-700" />
          <span>Rematch</span>
        </button>
        <button
          onClick={onExit}
          className="flex-1 px-4 py-3 border border-white/20 text-white font-black uppercase tracking-widest rounded-xl hover:bg-white/5 transition-all text-xs md:text-sm flex items-center justify-center hover:border-white/40 group gap-2"
        >
          <LogOut className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
          <span>Exit</span>
        </button>
      </motion.div>
    </motion.div>
  );
}
