import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Wallet, Play, AlertCircle, Info, Crosshair, Crown, Skull } from 'lucide-react';
import { useNeonBucks } from '../../NeonBucksStore';

interface WagerModesMenuProps {
  gameTitle: string;
  onCancel: () => void;
  onStart: (stake: number, mode: 'free_play' | 'slayer' | 'lms', targetKills?: number) => void;
  fixedMode?: 'free_play' | 'slayer' | 'lms';
}

export function WagerModesMenu({ gameTitle, onCancel, onStart, fixedMode }: WagerModesMenuProps) {
  const { balance, isFirstPractice, canAfford, wager, useFreeChance } = useNeonBucks();
  const [stake, setStake] = useState<number>(10);
  const [mode, setMode] = useState<'free_play' | 'slayer' | 'lms'>(fixedMode || 'free_play');
  const [targetKills, setTargetKills] = useState<number>(4);
  const [enablePresetTarget, setEnablePresetTarget] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (fixedMode) {
      setMode(fixedMode);
    }
  }, [fixedMode]);

  const handleStart = () => {
    const activeMode = fixedMode || mode;
    if (isFirstPractice) {
      useFreeChance();
      onStart(stake, activeMode, activeMode === 'free_play' && enablePresetTarget ? targetKills : undefined);
    } else {
      let requiredBalance = stake;
      if (activeMode === 'lms') {
         // LMS pot buy-in is the stake
         requiredBalance = stake;
      }
      
      // Wait, is it stake per kill? 
      // User: "whatever the amount of neon bucks the user put up he gets that for each kill"
      // So if I put up 10 bucks, I get 10 bucks per kill.
      // But does the "put up" mean I pay 10 bucks per kill? No, "the user put up 10... if they lose they're neon bucks disappear". So they put up a single entry fee of 10. And they win 10 for each kill.

      if (canAfford(requiredBalance)) {
        wager(requiredBalance);
        onStart(stake, activeMode, activeMode === 'free_play' && enablePresetTarget ? targetKills : undefined);
      } else {
        setError(`Not enough Neon Bucks. Required: ${requiredBalance}`);
      }
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#081616]/90 backdrop-blur-sm p-4 overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-lg bg-[#040b0b] border border-[#00FFD1]/30 rounded-2xl p-6 shadow-[0_0_50px_rgba(0,255,209,0.1)] text-white my-auto"
      >
        <div className="flex items-center gap-3 mb-6">
          <Wallet className="w-6 h-6 text-[#00FFD1]" />
          <h2 className="text-xl font-black italic uppercase tracking-wider text-[#00FFD1]">Wager Setup</h2>
        </div>

        <div className="bg-[#00FFD1]/5 border border-[#00FFD1]/20 rounded-xl p-4 mb-6 flex justify-between items-center">
          <span className="text-xs uppercase tracking-widest text-[#00FFD1]/70 font-semibold">Your Balance</span>
          <span className="text-xl font-black text-[#00FFD1] flex items-center gap-0">
            <img src="/neon-bucks-icon.png" alt="NB" referrerPolicy="no-referrer" className="h-6 w-auto inline-block drop-shadow-[0_0_5px_rgba(0,255,209,0.5)] -mr-1" /> {balance}
          </span>
        </div>

        {isFirstPractice && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 mb-6">
            <div className="flex items-start gap-2 text-yellow-500">
               <Info className="w-5 h-5 shrink-0" />
               <div className="text-xs font-semibold">
                 <p className="mb-1">First Practice Free Chance!</p>
                 <p className="text-yellow-500/70 font-normal">Play with no risk.</p>
               </div>
            </div>
          </div>
        )}

        <div className="space-y-4 mb-6">
          <label className="text-xs uppercase tracking-widest text-white/50">Wager Amount (Fee & Per Kill)</label>
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

        <div className="space-y-3 mb-6">
          <label className="text-xs uppercase tracking-widest text-white/50">Game Mode</label>
          
          {(!fixedMode || fixedMode === 'free_play') && (
            <div
              onClick={() => !fixedMode && setMode('free_play')}
              className={`p-4 border rounded-xl cursor-pointer transition-all ${
                mode === 'free_play'
                  ? 'border-[#00FFD1] bg-[#00FFD1]/10'
                  : 'border-white/10 bg-[#111E1E] hover:border-white/30'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Crosshair className={`w-4 h-4 ${mode === 'free_play' ? 'text-[#00FFD1]' : 'text-white/50'}`} />
                <span className="font-bold uppercase tracking-wider text-sm">Free Play</span>
              </div>
              <p className="text-[10px] text-white/50">
                Infinite timer. Manual cash out with 3s button, or preset a target here. Money can be stolen if killed!
              </p>
              {mode === 'free_play' && (
                <div className="mt-3 pt-3 border-t border-[#00FFD1]/20 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] text-white/70 font-semibold uppercase tracking-wider">Preset Cash-out Target</label>
                    <button
                      type="button"
                      onClick={() => setEnablePresetTarget(!enablePresetTarget)}
                      className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        enablePresetTarget ? 'bg-[#00FFD1]' : 'bg-white/10'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-[#040b0b] shadow ring-0 transition duration-200 ease-in-out ${
                          enablePresetTarget ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {enablePresetTarget ? (
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min="1"
                        max="20"
                        value={targetKills}
                        onChange={(e) => setTargetKills(Number(e.target.value))}
                        className="flex-1 accent-[#00FFD1]"
                      />
                      <span className="text-[#00FFD1] font-bold font-mono">{targetKills} Kills</span>
                    </div>
                  ) : (
                    <p className="text-[10px] text-white/40 italic">
                      Preset off. Manual cash-out only (hold the in-game CASHOUT button for 3s).
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {(!fixedMode || fixedMode === 'slayer') && (
            <div
              onClick={() => !fixedMode && setMode('slayer')}
              className={`p-4 border rounded-xl cursor-pointer transition-all ${
                mode === 'slayer'
                  ? 'border-[#00FFD1] bg-[#00FFD1]/10'
                  : 'border-white/10 bg-[#111E1E] hover:border-white/30'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Skull className={`w-4 h-4 ${mode === 'slayer' ? 'text-[#00FFD1]' : 'text-white/50'}`} />
                <span className="font-bold uppercase tracking-wider text-sm">Slayer</span>
              </div>
              <p className="text-[10px] text-white/50">
                What you kill is what you get! Winnings are secured even if you die. Last man standing ends the game.
              </p>
            </div>
          )}

          {(!fixedMode || fixedMode === 'lms') && (
            <div
              onClick={() => !fixedMode && setMode('lms')}
              className={`p-4 border rounded-xl cursor-pointer transition-all ${
                mode === 'lms'
                  ? 'border-[#00FFD1] bg-[#00FFD1]/10'
                  : 'border-white/10 bg-[#111E1E] hover:border-white/30'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Crown className={`w-4 h-4 ${mode === 'lms' ? 'text-[#00FFD1]' : 'text-white/50'}`} />
                <span className="font-bold uppercase tracking-wider text-sm">LAST MAN STANDING</span>
              </div>
              <p className="text-[10px] text-white/50">
                Last man standing wins the ENTIRE pot (simulated AI buy-ins).
              </p>
            </div>
          )}
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
             Start Match
           </button>
        </div>
      </motion.div>
    </div>
  );
}
