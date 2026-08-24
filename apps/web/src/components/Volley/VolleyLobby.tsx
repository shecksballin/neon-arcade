import React, { useState, useEffect, useRef } from "react";
import { LobbyLevelStrip } from '../common/LobbyLevelStrip';
import { FullscreenButton } from '../common/fullscreen';
import { ChevronLeft,
  Globe,
  Cpu,
  Swords,
  Settings as SettingsIcon,
  Maximize2 } from 'lucide-react';
import { motion, AnimatePresence } from "motion/react";
import { DifficultySelector } from "../common/DifficultySelector";
import {
  VOLLEY_DIFFICULTIES,
  VOLLEY_DEFAULT_DIFFICULTY,
  volleyDifficultyCaption,
} from "./volleyDifficulty";
import { LibraryBlob } from "../glass/LibraryBlob";
import { ParticleCard, GlobalSpotlight } from "../glass/MagicGameTile";
import PrivateWagerRoom from "../social/PrivateWagerRoom";
import LobbyModeTiles from "../common/LobbyModeTiles";

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
  const [selectedDifficulty, setSelectedDifficulty] = useState(VOLLEY_DEFAULT_DIFFICULTY);
  const [matchMode, setMatchMode] = useState<"classic" | "bestof3" | "sudden">(
    "classic",
  );
  const [showSettings, setShowSettings] = useState(false);
  // PRIVATE WAGER: invite-only match against a friend, in the regulation
  // selected above. VolleyGame keeps its `volleyGameStart` listener mounted
  // while this lobby is on screen, so the started match takes over on its own
  // — hence no `onStarted` handoff below.
  const [showPrivateWager, setShowPrivateWager] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);


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
  };

  return (
    // Scrollable, top-aligned on phones. `justify-center` inside an
    // `overflow-hidden` box taller than the viewport put the top of the
    // lobby ABOVE the visible area with no way to scroll to it — the mode
    // cards were simply unreachable on a phone.
    <div className="min-h-[100dvh] max-h-[100dvh] bg-[#081616] flex flex-col items-center justify-start md:justify-center px-4 py-24 md:p-6 relative overflow-y-auto overflow-x-hidden">
      <LibraryBlob />
      {/* Shared fullscreen affordance (the global 'f' bind works here too). */}
      <FullscreenButton positionClassName="fixed bottom-8 right-8 z-[60]" />
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
        
        {/* Level progression — compact strip under the title. */}
        <LobbyLevelStrip />

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

        <div className="w-full">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full text-left">
            <ParticleCard
              onClick={handleStartMultiplayer}
              className="magic-bento-card magic-bento-card--border-glow px-8 py-6 bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] rounded-2xl hover:shadow-[0_0_50px_rgba(0,255,209,0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
            >
              <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>
              {/* Branded "Wager Match" like every other lobby's online card —
                  the arcade-wide identity for ranked online play. */}
              <Globe className="w-8 h-8 group-hover:rotate-12 transition-transform" />
              <div className="text-center">
                <span className="block font-black text-xl uppercase tracking-tighter italic leading-none">Wager Match</span>
                <span className="block text-[8px] opacity-60 font-bold tracking-widest mt-1">
                  GLOBAL WAGER ARENA
                </span>
              </div>
            </ParticleCard>
            {/* PRIVATE WAGER — no local co-op exists here, so this is a NEW
                card styled exactly like Practice (design contract). It plays
                the regulation selected above against an invited friend. */}
            <ParticleCard
              onClick={() => setShowPrivateWager(true)}
              className="magic-bento-card magic-bento-card--border-glow px-8 py-6 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
            >
              <Swords className="w-8 h-8 text-zinc-400 group-hover:rotate-12 transition-transform group-hover:text-[#00FFD1]" />
              <div className="text-center">
                <span className="block font-black text-xl uppercase tracking-tighter italic leading-none">
                  Private Wager
                </span>
                <span className="block text-[8px] text-white/40 font-bold tracking-widest mt-1">
                  INVITE A FRIEND
                </span>
              </div>
            </ParticleCard>
            <ParticleCard
              onClick={handleStartComputer}
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
        </div>

        {/* Practice difficulty — applies to the Practice (Computer) match */}
        <div className="w-full max-w-xl mx-auto px-6 py-5 rounded-2xl border border-[#00FFD1]/25 bg-[#041010]/80">
          <DifficultySelector
            tiers={VOLLEY_DIFFICULTIES}
            value={selectedDifficulty}
            onChange={setSelectedDifficulty}
            title="Practice Difficulty"
            caption={volleyDifficultyCaption(selectedDifficulty)}
          />
        </div>

        {/* Shared lobby footer. Here the trio is the REGULATION PICKER (it
            has always been clickable in Volley), so it gets selection wired
            up — see common/LobbyModeTiles. */}
        <LobbyModeTiles
          tiles={[
            { id: 'classic', icon: 'videogame_asset', label: 'Practice' },
            { id: 'bestof3', icon: 'smart_toy', label: 'Online' },
            { id: 'sudden', icon: 'trending_up', label: 'Wager' },
          ]}
          selectedId={matchMode}
          onSelect={(id) => setMatchMode(id as 'classic' | 'bestof3' | 'sudden')}
        />
      </div>

      {/* Private-wager waiting room (diagonal 1v1 layout, READY → 3-2-1). */}
      {showPrivateWager && (
        <PrivateWagerRoom
          gameKey="volley"
          mode={matchMode}
          onClose={() => setShowPrivateWager(false)}
        />
      )}
    </div>
  );
};
export default VolleyLobby;
