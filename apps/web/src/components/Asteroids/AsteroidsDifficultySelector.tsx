// src/components/Asteroids/AsteroidsDifficultySelector.tsx
import React, { useState } from 'react';
import { Shield, ChevronRight, X, Target, Skull, Zap, Swords, ChevronLeft } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface AsteroidsDifficultySelectorProps {
  selectedDifficulty: number;
  onSelect: (difficulty: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

const CATEGORIES = [
  { 
    id: 'free', 
    name: 'FREE SECTOR', 
    icon: Shield, 
    desc: 'Unrestricted airspace with various engagement parameters.',
    submodes: [
      { id: 1, name: 'INFINITE', icon: Shield, desc: 'Pure kill cultivation. No boundaries, no limits.' },
    ]
  },
  { 
    id: 'eclipse', 
    name: 'ASTEROID ECLIPSE', 
    icon: Target, 
    desc: 'Dynamic safe zones. Move or succumb to the void.',
    submodes: [
      { id: 10, name: 'SLAYER', icon: Target, desc: 'Standard zone dynamics. Navigate the debris.' },
      { id: 11, name: 'SNAKE', icon: Zap, desc: 'Accelerated collapsing zones. Speed is armor.' },
    ]
  },
  { 
    id: 'blitz', 
    name: 'BLITZ', 
    icon: Skull, 
    desc: 'The ultimate survival test. Shrinking hull integrity field.',
    submodes: [
      { id: 12, name: 'SLAYER', icon: Swords, desc: 'Final standoff. Rank purely by kill count.' },
      { id: 13, name: 'SNAKE', icon: Skull, desc: 'Last one left wins. Defensive strategy required.' },
    ]
  },
];

const AsteroidsDifficultySelector = ({ selectedDifficulty, onSelect, onConfirm, onCancel }: AsteroidsDifficultySelectorProps) => {
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const currentCategory = CATEGORIES.find(c => c.id === activeCategory);

  return (
    <div className="w-full max-w-xl mx-auto space-y-6">
      <AnimatePresence mode="wait">
        {!activeCategory ? (
          <motion.div
            key="categories"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="grid grid-cols-1 gap-3"
          >
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => {
                  setActiveCategory(cat.id);
                  if (cat.submodes.length > 0) {
                    onSelect(cat.submodes[0].id);
                  }
                }}
                className="flex items-center gap-6 p-5 rounded-2xl border-2 border-white/5 bg-[#111E1E]/60 hover:border-[#00FFD1]/40 hover:bg-[#00FFD1]/5 transition-all text-left relative overflow-hidden group"
              >
                <div className="p-3 rounded-xl bg-white/5 text-[#00FFD1]">
                  <cat.icon className="w-6 h-6" />
                </div>
                <div className="flex-1">
                  <h3 className="font-black italic text-lg tracking-wider text-white uppercase">
                    {cat.name}
                  </h3>
                  <p className="text-[10px] font-mono text-white/40 uppercase tracking-widest mt-1">
                    {cat.desc}
                  </p>
                </div>
                <ChevronRight className="w-6 h-6 text-white/20 group-hover:text-[#00FFD1] transition-colors" />
              </button>
            ))}
          </motion.div>
        ) : (
          <motion.div
            key="submodes"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-4"
          >
            <button 
              onClick={() => setActiveCategory(null)}
              className="flex items-center gap-2 text-xs font-mono text-[#00FFD1] hover:opacity-70 transition-all uppercase tracking-widest mb-2"
            >
              <ChevronLeft className="w-4 h-4" /> Back to Sectors
            </button>

            <div className="grid grid-cols-1 gap-3">
              {currentCategory?.submodes.map((sub) => (
                <button
                  key={sub.id}
                  onClick={() => onSelect(sub.id)}
                  className={`flex items-center gap-6 p-4 rounded-2xl border-2 transition-all duration-300 text-left relative overflow-hidden group ${
                    selectedDifficulty === sub.id 
                      ? 'bg-[#00FFD1]/10 border-[#00FFD1] shadow-[0_0_30px_rgba(0,255,209,0.2)]' 
                      : 'bg-[#111E1E]/60 border-white/5 hover:border-white/20'
                  }`}
                >
                  <div className={`p-3 rounded-xl bg-white/5 ${selectedDifficulty === sub.id ? 'text-[#00FFD1]' : 'text-white/40'}`}>
                    <sub.icon className="w-6 h-6" />
                  </div>
                  
                  <div className="flex-1">
                    <h3 className={`font-black italic text-lg tracking-wider transition-colors ${selectedDifficulty === sub.id ? 'text-white' : 'text-white/60'}`}>
                      {sub.name}
                    </h3>
                    <p className="text-[10px] font-mono text-white/40 uppercase tracking-widest mt-0.5">
                      {sub.desc}
                    </p>
                  </div>

                  {selectedDifficulty === sub.id && (
                    <div className="absolute right-4 animate-pulse">
                      <ChevronRight className="w-6 h-6 text-[#00FFD1]" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex gap-4 pt-2">
        <button
          onClick={onCancel}
          className="flex-1 px-8 py-4 border border-white/10 text-white/60 font-black uppercase tracking-widest rounded-xl hover:bg-white/5 transition-all flex items-center justify-center gap-2"
        >
          <X className="w-4 h-4" />
          Abort
        </button>
        <button
          onClick={onConfirm}
          disabled={!activeCategory}
          className={`flex-[2] px-8 py-4 font-black uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-2 ${
            activeCategory 
              ? 'bg-[#00FFD1] text-[#081616] hover:shadow-[0_0_30px_rgba(0,255,209,0.4)]' 
              : 'bg-white/5 text-white/20 cursor-not-allowed'
          }`}
        >
          Launch Mission
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
};

export default AsteroidsDifficultySelector;
