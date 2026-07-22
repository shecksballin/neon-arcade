const fs = require('fs');

const lobbies = [
  'src/components/Asteroids/AsteroidsLobby.tsx',
  'src/components/Cells/CellsLobby.tsx',
  'src/components/Chess/GameLobby.tsx',
  'src/components/Clumsy/ClumsyLobby.tsx',
  'src/components/Golf/GolfLobby.tsx',
  'src/components/Killer/KillerLobby.tsx',
  'src/components/Trivia/TriviaLobby.tsx',
  'src/components/Volley/VolleyLobby.tsx'
];

lobbies.forEach(file => {
  if (!fs.existsSync(file)) return;
  let code = fs.readFileSync(file, 'utf8');

  if (code.includes('lucide-react') && !code.includes('CircleDollarSign')) {
    code = code.replace(/import\s+\{([^}]+)\}\s+from\s+['"]lucide-react['"];/, (m, p1) => {
      return `import { ${p1.trim()}, CircleDollarSign } from 'lucide-react';`;
    });
  }

  const newGrid = `            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full text-left">
              <ParticleCard
                onClick={__PRACTICE_CLICK__}
                className="magic-bento-card magic-bento-card--border-glow px-4 py-6 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
              >
                <Cpu className="w-8 h-8 text-zinc-400 group-hover:rotate-12 transition-transform" />
                <div className="text-center">
                  <span className="block font-black text-lg md:text-xl uppercase tracking-tighter italic leading-none">
                    Practice
                  </span>
                </div>
              </ParticleCard>
              <ParticleCard
                onClick={__ONLINE_CLICK__}
                className="magic-bento-card magic-bento-card--border-glow px-4 py-6 bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] rounded-2xl hover:shadow-[0_0_50px_rgba(0,255,209,0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
              >
                <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>
                <Globe className="w-8 h-8 group-hover:rotate-12 transition-transform" />
                <div className="text-center">
                  <span className="block font-black text-lg md:text-xl uppercase tracking-tighter italic leading-none">
                    Online
                  </span>
                </div>
              </ParticleCard>
              <ParticleCard
                onClick={__WAGER_CLICK__}
                className="magic-bento-card magic-bento-card--border-glow px-4 py-6 bg-gradient-to-br from-[#FFD700] to-[#DAA520] text-[#081616] rounded-2xl hover:shadow-[0_0_50px_rgba(255,215,0,0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
              >
                <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>
                <CircleDollarSign className="w-8 h-8 group-hover:rotate-12 transition-transform" />
                <div className="text-center">
                  <span className="block font-black text-lg md:text-xl uppercase tracking-tighter italic leading-none">
                    Wager
                  </span>
                </div>
              </ParticleCard>
            </div>`;

  // We will customize this replacement specifically for each lobby since they have slightly different structures.
});
