import { useRef, useState } from "react";
import { LobbyLevelStrip } from '../common/LobbyLevelStrip';
import { Globe, Cpu, Swords } from 'lucide-react';
import { LibraryBlob } from "../glass/LibraryBlob";
import { ParticleCard, GlobalSpotlight } from "../glass/MagicGameTile";
import PrivateWagerRoom from "../social/PrivateWagerRoom";
import LobbyModeTiles from "../common/LobbyModeTiles";

/**
 * Neon Clumsy lobby.
 *
 * Three entry cards — WAGER MATCH, PRIVATE WAGER, PRACTICE — closed by the
 * shared PRACTICE / ONLINE / WAGER tile row every arcade lobby ends with
 * (see common/LobbyModeTiles).
 */
interface ClumsyLobbyProps {
  /** Enter the online queue — the parent shows SEARCHING FOR ONLINE MATCH. */
  onFindGame: () => void;
  /** Local practice round. Behaviour unchanged. */
  onPlayComputer: () => void;
  onExit: () => void;
  /** Matchmaking refusal to surface (e.g. account setup unfinished). */
  error?: string | null;
}

const ClumsyLobby = ({ onFindGame, onPlayComputer, error }: ClumsyLobbyProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // PRIVATE WAGER: invite-only round against a friend. ClumsyGame's
  // `useOnlineLobbyQueue` keeps its `lobbyGame:start` listener mounted while
  // this lobby is on screen, so the started match takes over on its own —
  // hence no `onStarted` handoff below.
  const [showPrivateWager, setShowPrivateWager] = useState(false);

  return (
    <div className="min-h-screen bg-[#081616] flex flex-col items-center justify-center p-6 relative overflow-hidden">
      <LibraryBlob />
      <GlobalSpotlight gridRef={containerRef} />
      {/* Animated background highlights */}
      <div className="absolute inset-0 opacity-20 pointer-events-none">
        <div className="absolute top-20 left-20 w-96 h-96 bg-[#00FFD1] rounded-full blur-[120px] opacity-20 animate-pulse"></div>
        <div
          className="absolute bottom-20 right-20 w-96 h-96 bg-[#FF0080] rounded-full blur-[120px] opacity-20 animate-pulse"
          style={{ animationDelay: "1s" }}
        ></div>
      </div>
      <div ref={containerRef} className="relative z-10 text-center space-y-8 max-w-2xl w-full">
        <div className="space-y-2">
          <h1 className="text-6xl md:text-8xl font-black text-[#FFFFFD] drop-shadow-[0_0_20px_rgba(0,255,209,0.6)] uppercase tracking-tighter italic">
            NEON CLUMSY
          </h1>
        </div>
        
        {/* Level progression — compact strip under the title. */}
        <LobbyLevelStrip />
        <div className="w-full">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full text-left">
            <ParticleCard
              onClick={onFindGame}
              className="magic-bento-card magic-bento-card--border-glow px-8 py-6 bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] rounded-2xl hover:shadow-[0_0_50px_rgba(0,255,209,0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
            >
              <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>
              <Globe className="w-8 h-8 group-hover:rotate-12 transition-transform" />
              <div className="text-center">
                <span className="block font-black text-xl uppercase tracking-tighter italic leading-none">Wager Match</span>
                <span className="block text-[8px] opacity-60 font-bold tracking-widest mt-1">
                  GLOBAL WAGER ARENA
                </span>
              </div>
            </ParticleCard>
            {/* PRIVATE WAGER — new card (this lobby has no local co-op to
                replace), styled exactly like Practice per the contract. */}
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
              onClick={onPlayComputer}
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

        {/* Matchmaking refusals (no account, servers unreachable, …) */}
        {error && (
          <p className="text-[10px] font-mono tracking-[0.25em] uppercase text-[#FF6B9A]">
            {error}
          </p>
        )}

        <p className="text-[9px] font-mono tracking-[0.3em] uppercase text-[#B1C5FF]/40">
          Online matches are free — no stake, no entry fee
        </p>

        <LobbyModeTiles />
      </div>

      {/* Private-wager waiting room (diagonal 1v1 layout, READY → 3-2-1). */}
      {showPrivateWager && (
        <PrivateWagerRoom
          gameKey="clumsy"
          mode="classic"
          onClose={() => setShowPrivateWager(false)}
        />
      )}
    </div>
  );
};

export default ClumsyLobby;
