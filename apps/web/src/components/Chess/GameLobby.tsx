import React, { useRef, useState } from "react";
import { LobbyLevelStrip } from '../common/LobbyLevelStrip';
import { Globe, Cpu, Users, Swords } from 'lucide-react';
import GameBackButton from '../common/GameBackButton';
import { LibraryBlob } from "../glass/LibraryBlob";
import { ParticleCard, GlobalSpotlight } from "../glass/MagicGameTile";
import { DifficultySelector } from "./DifficultySelector";
import PrivateWagerRoom from "../social/PrivateWagerRoom";
import LobbyModeTiles from "../common/LobbyModeTiles";

interface GameLobbyProps {
  onFindGame: () => void;
  onPlayComputer: () => void;
  onPlayLocal: () => void;
  onExit: () => void;
  /** Selected practice-mode engine skill level (0–20). */
  difficulty: number;
  onDifficultyChange: (skillLevel: number) => void;
}

const GameLobby = ({
  onFindGame,
  onPlayComputer,
  onPlayLocal,
  onExit,
  difficulty,
  onDifficultyChange,
}: GameLobbyProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // PRIVATE WAGER: invite-only match against a friend. The room is a full
  // screen overlay on top of this lobby — ChessGame keeps its `gameStart`
  // listener mounted the whole time, so when the server starts the private
  // match the normal online game takes over and this lobby unmounts with it.
  // (That is why no `onStarted` is passed.)
  const [showPrivateWager, setShowPrivateWager] = useState(false);

  const handleStartMultiplayer = () => {
    onFindGame();
  };

  const handleStartComputer = () => {
    onPlayComputer();
  };

  return (
    // Scrollable, top-aligned on phones. `justify-center` inside an
    // `overflow-hidden` box taller than the viewport put the top of the
    // lobby ABOVE the visible area with no way to scroll to it — the mode
    // cards were simply unreachable on a phone.
    <div className="min-h-[100dvh] max-h-[100dvh] bg-[#081616] flex flex-col items-center justify-start md:justify-center px-4 py-24 md:p-6 relative overflow-y-auto overflow-x-hidden">
      <GameBackButton onClick={onExit} title="Back to arcade" positionClassName="absolute top-6 left-6 z-50" />
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
            NEON CHESS
          </h1>
        </div>
        
        {/* Level progression — compact strip under the title. */}
        <LobbyLevelStrip />

        <div className="w-full">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full text-left">
            <ParticleCard
              onClick={handleStartMultiplayer}
              className="magic-bento-card magic-bento-card--border-glow px-8 py-6 bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] rounded-2xl hover:shadow-[0_0_50px_rgba(0,255,209,0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
            >
              <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>
              {/* NO MONEY ONLINE: this card used to read "Wager Match" with a
                  dollar icon. Online play stakes nothing — it is just chess
                  against a real person — so the copy and icon now say that. */}
              <Globe className="w-8 h-8 group-hover:rotate-12 transition-transform" />
              <div className="text-center">
                <span className="block font-black text-xl uppercase tracking-tighter italic leading-none">Wager Match</span>
                <span className="block text-[8px] opacity-60 font-bold tracking-widest mt-1">
                  GLOBAL WAGER ARENA
                </span>
              </div>
            </ParticleCard>

            {/* PRIVATE WAGER — replaces the old LOCAL CO-OP card (design
                contract). Pick an online friend, both press READY, 3-2-1, and
                the normal online chess match starts between just the two of
                you. Free: "wager" is a name, nothing is staked. */}
            <ParticleCard
              onClick={() => setShowPrivateWager(true)}
              className="magic-bento-card magic-bento-card--border-glow px-8 py-6 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer hover:border-[#00FFD1]"
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
              className="magic-bento-card magic-bento-card--border-glow px-8 py-6 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer hover:border-[#00FFD1]"
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

        {/* LOCAL CO-OP kept reachable. The contract replaced its CARD with
            Private Wager, but pass & play itself must keep working exactly as
            today — so it lives on as this secondary link. Delete this block if
            the mode should disappear from the UI entirely. */}
        <button
          type="button"
          onClick={onPlayLocal}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-full border border-[#00FFD1]/25 text-[9px] font-mono font-bold uppercase tracking-[0.25em] text-[#B1C5FF]/50 hover:text-[#B1C5FF] hover:border-[#00FFD1]/60 transition-all cursor-pointer"
        >
          <Users className="w-3.5 h-3.5" />
          Local Co-Op · Pass &amp; Play
        </button>

        {/* Practice difficulty — applies to the Practice (Computer) match */}
        <div className="w-full max-w-xl mx-auto px-6 py-5 rounded-2xl border border-[#00FFD1]/25 bg-[#041010]/80">
          <DifficultySelector
            value={difficulty}
            onChange={onDifficultyChange}
            title="Practice Difficulty"
          />
        </div>

          {/* Shared lobby footer. Third tile reads RANKED, not WAGER: online
              chess stakes nothing, it only moves ELO. */}
          <LobbyModeTiles
            tiles={[
              { id: 'practice', icon: 'videogame_asset', label: 'Practice' },
              { id: 'online', icon: 'smart_toy', label: 'Online' },
              { id: 'ranked', icon: 'trending_up', label: 'Ranked' },
            ]}
          />
      </div>

      {/* Private-wager waiting room (diagonal 1v1 layout, READY → 3-2-1). */}
      {showPrivateWager && (
        <PrivateWagerRoom
          gameKey="chess"
          mode="1v1"
          onClose={() => setShowPrivateWager(false)}
        />
      )}
    </div>
  );
};
export default GameLobby;