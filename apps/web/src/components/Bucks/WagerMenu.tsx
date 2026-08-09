import React, { useState } from 'react';
import { useNeonBucks } from '../../NeonBucksStore';
import { motion } from 'motion/react';
import { Wallet, Play, AlertCircle, Info } from 'lucide-react';

interface WagerMenuProps {
  onStart: (stake: number) => void;
  onCancel: () => void;
  gameTitle: string;
}

export function WagerMenu({ onStart, onCancel, gameTitle }: WagerMenuProps) {
  const { balance, isFirstPractice, canAfford, wager, useFreeChance } = useNeonBucks();
  const [stake, setStake] = useState<number>(10);
  const [error, setError] = useState<string | null>(null);

  const handleStart = () => {
    if (isFirstPractice) {
      useFreeChance();
      onStart(stake);
    } else {
      if (canAfford(stake)) {
        wager(stake);
        onStart(stake);
      } else {
        setError("Not enough Neon Bucks.");
      }
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#081616]/90 backdrop-blur-sm p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md bg-[#040b0b] border border-[#00FFD1]/30 rounded-2xl p-6 shadow-[0_0_50px_rgba(0,255,209,0.1)] text-white"
      >
        {gameTitle.toLowerCase().includes('quiz') || gameTitle.toLowerCase().includes('trivia') ? (
          <>
            <div className="flex items-center gap-3 mb-6">
              <Wallet className="w-6 h-6 text-[#00FFD1]" />
              <h2 className="text-xl font-black italic uppercase tracking-wider text-[#00FFD1]">Quiz Self-Wager</h2>
            </div>

            <p className="text-sm text-white/70 mb-6 font-mono">
              Self-Wager on your own knowledge in {gameTitle}! Correct answers add the stake to your balance, while incorrect answers deduct it from your balance.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-6">
              <Wallet className="w-6 h-6 text-[#00FFD1]" />
              <h2 className="text-xl font-black italic uppercase tracking-wider text-[#00FFD1]">Practice Wager</h2>
            </div>

            <p className="text-sm text-white/70 mb-6 font-mono">
              Wager Neon Bucks against the computer in {gameTitle}. Win to double your stake!
            </p>
          </>
        )}

        <div className="bg-[#00FFD1]/5 border border-[#00FFD1]/20 rounded-xl p-4 mb-6 flex justify-between items-center">
          <span className="text-xs uppercase tracking-widest text-[#00FFD1]/70 font-semibold">Your Balance</span>
          <span className="text-xl font-black text-[#00FFD1] flex items-center gap-0">
            <img src="/neon-bucks-icon.png" alt="NB" referrerPolicy="no-referrer" className="h-6 w-auto inline-block drop-shadow-[0_0_5px_rgba(0,255,209,0.5)] -mr-1" /> {balance}
          </span>
        </div>

        {isFirstPractice && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 mb-6">
            <div className="flex items-start gap-2 text-yellow-500">
               <Info className="w-5 h-5 shrink-0" />
               <div className="text-xs font-semibold">
                 <p className="mb-1">First Practice Free Chance!</p>
                 <p className="text-yellow-500/70 font-normal">
                   {gameTitle.toLowerCase().includes('quiz') || gameTitle.toLowerCase().includes('trivia') ? (
                     "Choose your virtual per-question stake. Correct answers add to your balance, but incorrect answers won't cost you a single buck!"
                   ) : (
                     "Choose your virtual wager. If you win, you get the bucks. If you lose, it costs you nothing."
                   )}
                 </p>
               </div>
            </div>
          </div>
        )}

        <div className="space-y-4 mb-8">
          <div className="flex justify-between items-center">
            <span className="text-xs uppercase tracking-widest text-white/50">
              {gameTitle.toLowerCase().includes('quiz') || gameTitle.toLowerCase().includes('trivia') ? 'Per-Question Stake' : 'Wager Amount'}
            </span>
            <span className="text-lg font-bold text-white flex items-center gap-0">
              <img src="/neon-bucks-icon.png" alt="NB" referrerPolicy="no-referrer" className="h-5 w-auto inline-block -mr-0.5" /> {stake}
            </span>
          </div>
          
          <input
            type="range"
            min="1"
            max={isFirstPractice ? 100 : Math.max(balance, 1)}
            step="1"
            value={stake}
            onChange={(e) => setStake(Number(e.target.value))}
            className="w-full accent-[#00FFD1] bg-[#111E1E] rounded-lg appearance-none h-2 cursor-pointer"
          />
          <div className="flex justify-center">
            <div className="py-2 px-6 rounded-lg text-lg font-bold border border-[#00FFD1] bg-[#00FFD1]/10 text-white flex items-center justify-center gap-0 min-w-[120px]">
              <img src="/neon-bucks-icon.png" alt="NB" referrerPolicy="no-referrer" className="h-6 w-auto drop-shadow-[0_0_5px_rgba(0,255,209,0.5)] -mr-1" />
              <span>{stake}</span>
            </div>
          </div>
        </div>

        {error && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 text-red-400 text-xs mb-4 p-2 bg-red-400/10 rounded border border-red-400/20">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </motion.div>
        )}

        <div className="flex gap-3 mt-4">
           <button
             onClick={onCancel}
             className="flex-1 py-3 border border-white/20 text-white font-bold uppercase tracking-wider rounded-xl hover:bg-white/5 transition-colors"
           >
             Cancel
           </button>
           <button
             onClick={handleStart}
             disabled={!isFirstPractice && !canAfford(stake)}
             className="flex-1 py-3 bg-[#00FFD1] text-[#081616] font-black uppercase tracking-wider rounded-xl shadow-[0_0_20px_rgba(0,255,209,0.3)] hover:scale-105 transition-transform disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2"
           >
             <Play className="w-4 h-4" fill="currentColor" />
             Start
           </button>
        </div>
      </motion.div>
    </div>
  );
}
