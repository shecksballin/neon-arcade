import React from 'react';

interface Difficulty {
  level: number;
  name: string;
  description: string;
  speed: number;
  icon: string;
}

interface DifficultySelectorProps {
  selectedDifficulty: number;
  onSelect: (level: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

const VolleyDifficultySelector = ({ selectedDifficulty, onSelect, onConfirm, onCancel }: DifficultySelectorProps) => {
  const difficulties: Difficulty[] = [
    {
      level: 1,
      name: 'Training',
      description: 'Slow reflex bot for practice',
      speed: 800,
      icon: 'favorite'
    },
    {
      level: 2,
      name: 'Amateur',
      description: 'Casual pace for intermediate players',
      speed: 1200,
      icon: 'star'
    },
    {
      level: 3,
      name: 'Professional',
      description: 'Fast reflexes and sharp angles',
      speed: 2200,
      icon: 'diamond'
    },
    {
      level: 4,
      name: 'Cyberpunk',
      description: 'Enhanced reaction speeds',
      speed: 2800,
      icon: 'verified'
    },
    {
      level: 5,
      name: 'Apex AI',
      description: 'The ultimate visual intelligence',
      speed: 3500,
      icon: 'crown'
    }
  ];

  const current = difficulties[selectedDifficulty - 1];

  return (
    <div className="space-y-6 flex flex-col items-center">
      <h2 className="text-2xl font-bold text-[#FFFFFD] uppercase tracking-widest neon-text-glow">
        Select Difficulty
      </h2>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 w-full max-w-4xl">
        {difficulties.map((diff) => (
          <button
            key={diff.level}
            onClick={() => onSelect(diff.level)}
            className={`relative p-4 rounded-lg border-2 transition-all transform hover:scale-105 active:scale-95 ${
              selectedDifficulty === diff.level
                ? 'border-[#00FFD1] bg-[#00FFD1]/10 shadow-[0_0_20px_rgba(0,255,209,0.4)]'
                : 'border-[#3A4A44]/40 bg-[#111E1E] hover:border-[#00FFD1]/50'
            }`}
          >
            <div className="flex flex-col items-center gap-2">
              <span className="material-symbols-outlined text-2xl text-[#00FFD1]">
                {diff.icon}
              </span>
              <p className="font-bold text-xs text-[#FFFFFD] uppercase tracking-wider">
                {diff.name}
              </p>
              <p className="text-[10px] font-mono text-[#B1C5FF]/70">{diff.speed}</p>
            </div>
          </button>
        ))}
      </div>

      <div className="backdrop-blur-xl bg-[#2a3737]/60 p-6 rounded-lg border border-[#00FFD1]/20 w-full max-w-2xl text-center">
        <div className="space-y-2 mb-4">
          <h3 className="font-bold text-[#00FFD1] uppercase tracking-widest">
            {current.name}
          </h3>
          <p className="text-sm text-[#B1C5FF]">
            {current.description}
          </p>
        </div>

        <div className="space-y-1 text-[10px] text-[#B1C5FF]/70 font-mono uppercase tracking-widest">
          <p>⚡ Reaction Level: {selectedDifficulty * 4}/20</p>
          <p>🎯 Accuracy: {70 + selectedDifficulty * 5}%</p>
          <p>🏎️ Max Paddle Velocity: {3 + selectedDifficulty * 1.5}px/frame</p>
        </div>
      </div>

      <div className="flex gap-4 w-full max-w-2xl">
        <button
          onClick={onCancel}
          className="flex-1 px-6 py-4 border border-[#3A4A44]/40 text-[#B1C5FF] font-bold rounded-lg hover:bg-[#111E1E] transition-all uppercase tracking-widest text-xs"
        >
          Back
        </button>
        <button
          onClick={onConfirm}
          className="flex-1 px-6 py-4 bg-gradient-to-r from-[#00FFD1] to-[#00e0b7] text-[#081616] font-display font-black rounded-lg hover:shadow-[0_0_20px_rgba(0,255,209,0.4)] transition-all uppercase tracking-widest text-xs"
        >
          Initialize Match
        </button>
      </div>
    </div>
  );
};

export default VolleyDifficultySelector;
