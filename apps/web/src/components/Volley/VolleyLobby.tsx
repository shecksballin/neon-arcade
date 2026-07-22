import React, { useState, useEffect, useRef } from "react";
import { ChevronLeft,
  Globe,
  Cpu,
  Settings as SettingsIcon,
  Maximize2, CircleDollarSign } from 'lucide-react';
import { motion, AnimatePresence } from "motion/react";
import VolleyDifficultySelector from "./VolleyDifficultySelector";
import { LibraryBlob } from "../glass/LibraryBlob";
import { ParticleCard, GlobalSpotlight } from "../glass/MagicGameTile";

interface VolleyLobbyProps {
  onFindGame: (player: { matchMode: "classic" | "bestof3" | "sudden" }) => void;
  onPlayComputer: (player: {
    difficulty: number;
    matchMode: "classic" | "bestof3" | "sudden";
  }) => void;
  onExit: () => void;
  settings: { ghostMode: boolean; minimalistMode: boolean };
  onSettingsChange: (settings: {
    ghostMode: boolean;
    minimalistMode: boolean;
  }) => void;
}

const VolleyLobby = ({
  onFindGame,
  onPlayComputer,
  onExit,
  settings,
  onSettingsChange,
}: VolleyLobbyProps) => {
  const [showDifficulty, setShowDifficulty] = useState(false);
  const [selectedDifficulty, setSelectedDifficulty] = useState(3);
  const [matchMode, setMatchMode] = useState<"classic" | "bestof3" | "sudden">(
    "classic",
  );
  const [showSettings, setShowSettings] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "f") {
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleStartMultiplayer = () => {
    onFindGame({
      matchMode,
    });
  };

  const handleStartComputer = () => {
    onPlayComputer({
      difficulty: selectedDifficulty,
      matchMode,
    });
    setShowDifficulty(false);
  };

  return (
    <div className="min-h-screen bg-[#081616] flex flex-col items-center justify-center p-6 relative overflow-hidden">
      <LibraryBlob />
      <GlobalSpotlight gridRef={containerRef} />

      {/* Animated background highlights */}
      <div className="absolute inset-0 opacity-20 pointer-events-none">
        <div className="absolute top-20 left-20 w-96 h-96 bg-[#00FFD1] rounded-full blur-[120px] opacity-20 animate-pulse"></div>
        <div
          className="absolute bottom-20 right-20 w-96 h-96 bg-[#0452c4] rounded-full blur-[120px] opacity-20 animate-pulse"
          style={{ animationDelay: "1s" }}
        ></div>
      </div>

      <div ref={containerRef} className="relative z-10 text-center space-y-8 max-w-2xl w-full">
        <div className="space-y-2">
          <h1 className="text-6xl md:text-8xl font-black text-[#FFFFFD] drop-shadow-[0_0_20px_rgba(0,255,209,0.6)] uppercase tracking-tighter italic">
            NEON VOLLEY
          </h1>
        </div>

        {!showDifficulty && (
          <div className="space-y-6">
            <div className="flex flex-col items-center gap-3">
              <p className="text-[10px] font-mono tracking-[0.3em] uppercase text-[#B1C5FF]/50">
                Select Regulation
              </p>
              <div className="flex gap-2 p-1 bg-[#111E1E]/80 border border-[#00FFD1]/20 rounded-lg backdrop-blur-md">
                {(["classic", "bestof3", "sudden"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setMatchMode(mode)}
                    className={`px-4 py-2 rounded-md text-[10px] font-bold uppercase tracking-widest transition-all ${
                      matchMode === mode
                        ? "bg-[#00FFD1] text-[#081616] shadow-[0_0_15px_rgba(0,255,209,0.5)]"
                        : "text-[#B1C5FF]/50 hover:text-[#B1C5FF]"
                    }`}
                  >
                    {mode === "classic"
                      ? "11 Points"
                      : mode === "bestof3"
                        ? "Best of 3"
                        : "Sudden Death"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

                <div className="w-full">
          {!showDifficulty ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full text-left">
              <ParticleCard
                onClick={handleStartMultiplayer}
                className="magic-bento-card magic-bento-card--border-glow px-8 py-6 bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] rounded-2xl hover:shadow-[0_0_50px_rgba(0,255,209,0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
              >
                <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>
                <CircleDollarSign className="w-8 h-8 group-hover:rotate-12 transition-transform" />
                <div className="text-center">
                  <span className="block font-black text-xl uppercase tracking-tighter italic leading-none">Wager Match</span>
                  <span className="block text-[8px] opacity-60 font-bold tracking-widest mt-1">
                    GLOBAL WAGER ARENA
                  </span>
                </div>
              </ParticleCard>
              <ParticleCard
                onClick={() => setShowDifficulty(true)}
                className="magic-bento-card magic-bento-card--border-glow px-8 py-6 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
              >
                <Cpu className="w-8 h-8 text-zinc-400 group-hover:rotate-12 transition-transform" />
                <div className="text-center">
                  <span className="block font-black text-xl uppercase tracking-tighter italic leading-none">
                    Practice
                  </span>
                  <span className="block text-[8px] text-white/40 font-bold tracking-widest mt-1">
                    COMPUTER ENGINE
                  </span>
                </div>
              </ParticleCard>
            </div>
          ) : (
            <VolleyDifficultySelector
              selectedDifficulty={selectedDifficulty}
              onSelect={setSelectedDifficulty}
              onConfirm={handleStartComputer}
              onCancel={() => setShowDifficulty(false)}
            />
          )}
        </div>
{!showDifficulty && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-12">
            <ParticleCard 
              onClick={() => setMatchMode('classic')}
              className={`magic-bento-card magic-bento-card--border-glow backdrop-blur-md p-5 rounded-xl border flex flex-col items-center gap-2 transition-all cursor-pointer ${matchMode === 'classic' ? 'border-[#00FFD1] shadow-[0_0_15px_rgba(0,255,209,0.5)]' : 'border-[#00FFD1]/40'}`}
            >
              <div className="material-symbols-outlined text-[#00FFD1] text-2xl">
                videogame_asset
              </div>
              <p className="text-[10px] font-mono tracking-widest uppercase text-[#B1C5FF]/70">
                Practice
              </p>
            </ParticleCard>
            <ParticleCard 
              onClick={() => setMatchMode('bestof3')}
              className={`magic-bento-card magic-bento-card--border-glow backdrop-blur-md p-5 rounded-xl border flex flex-col items-center gap-2 transition-all cursor-pointer ${matchMode === 'bestof3' ? 'border-[#00FFD1] shadow-[0_0_15px_rgba(0,255,209,0.5)]' : 'border-[#00FFD1]/40'}`}
            >
              <div className="material-symbols-outlined text-[#00FFD1] text-2xl">
                smart_toy
              </div>
              <p className="text-[10px] font-mono tracking-widest uppercase text-[#B1C5FF]/70">
                Online
              </p>
            </ParticleCard>
            <ParticleCard 
              onClick={() => setMatchMode('sudden')}
              className={`magic-bento-card magic-bento-card--border-glow backdrop-blur-md p-5 rounded-xl border flex flex-col items-center gap-2 transition-all cursor-pointer ${matchMode === 'sudden' ? 'border-[#00FFD1] shadow-[0_0_15px_rgba(0,255,209,0.5)]' : 'border-[#00FFD1]/40'}`}
            >
              <div className="material-symbols-outlined text-[#00FFD1] text-2xl">
                trending_up
              </div>
              <p className="text-[10px] font-mono tracking-widest uppercase text-[#B1C5FF]/70">
                Wager
              </p>
            </ParticleCard>
          </div>
        )}
      </div>
    </div>
  );
};
export default VolleyLobby;