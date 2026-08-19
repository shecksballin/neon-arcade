// src/components/Asteroids/AsteroidsLobby.tsx
//
// ONLINE and PRACTICE now pick their rules in THE SAME COMPONENT:
//
//   WAGER MATCH / PRIVATE WAGER → <AsteroidsDifficultySelector
//        includeFreeSector={false}>: the identical drill-down practice uses
//        (sector list → submode list → "Back to Sectors" → Abort/confirm),
//        with the FREE SECTOR / INFINITE card filtered out.
//        FREE PLAY IS NOT OFFERED ONLINE (design contract) — the permanent
//        free-play world stays reachable from practice only, and it is
//        `includeFreeSector={false}` that enforces it.
//   PRACTICE → <AsteroidsDifficultySelector> with no extra props, unchanged.
//
// A (sector, mode) pair IS a practice difficulty code in disguise
// (eclipse·slayer = 10 … blitz·lms = 13), so an online ECLIPSE·SLAYER match
// runs the exact zone a practice ECLIPSE·SLAYER run runs. That table lives in
// AsteroidsDifficultySelector.tsx ONCE — this file only translates.
import React, { useMemo, useState, useRef } from "react";
import { LobbyLevelStrip } from '../common/LobbyLevelStrip';
import { Cpu, Globe, Swords } from 'lucide-react';
import AsteroidsDifficultySelector, {
  ASTEROIDS_DEFAULT_ONLINE_DIFFICULTY,
  asteroidsDifficultyToSectorMode,
  asteroidsSectorModeToDifficulty,
  type AsteroidsSectorCopy,
  type AsteroidsSectorId,
} from "./AsteroidsDifficultySelector";
import { LibraryBlob } from "../glass/LibraryBlob";
import { ParticleCard, GlobalSpotlight } from "../glass/MagicGameTile";
import PrivateWagerRoom from "../social/PrivateWagerRoom";
import { usePrivateWagerStarted } from "../social/PrivateWagerInvite";
import LobbyModeTiles from "../common/LobbyModeTiles";

// ---------------------------------------------------------------------------
// THE FOUR ONLINE OPTIONS
// ---------------------------------------------------------------------------

/** The online sectors — the same two practice offers (free play excluded). */
export type OnlineSector = 'eclipse' | 'blitz';
/** The two modes every sector offers. SLAYER has no winner; LMS does. */
export type OnlineMatchMode = 'slayer' | 'lms';
/** One of the four online options: sector × mode. */
export interface OnlineChoice {
  sector: OnlineSector;
  mode: OnlineMatchMode;
}

/**
 * (sector, mode) → the PRACTICE difficulty code that already encodes both.
 * `AsteroidsCore` keys the safe-zone simulation off this number, and the
 * server derives the SAME number from the same pair, so the online zone and
 * the practice zone are the same zone.
 *
 * DERIVED, never re-declared: every entry comes from the one mapping in
 * AsteroidsDifficultySelector.tsx. Kept as an export because AsteroidsGame
 * reads it.
 */
export const ONLINE_DIFFICULTY: Record<OnlineSector, Record<OnlineMatchMode, number>> = {
  eclipse: {
    slayer: asteroidsSectorModeToDifficulty('eclipse', 'slayer'),
    lms: asteroidsSectorModeToDifficulty('eclipse', 'lms'),
  },
  blitz: {
    slayer: asteroidsSectorModeToDifficulty('blitz', 'slayer'),
    lms: asteroidsSectorModeToDifficulty('blitz', 'lms'),
  },
};

/** What the picker starts on. */
export const DEFAULT_ONLINE_CHOICE: OnlineChoice =
  asteroidsDifficultyToSectorMode(ASTEROIDS_DEFAULT_ONLINE_DIFFICULTY) ?? { sector: 'eclipse', mode: 'slayer' };

/**
 * Wire id for one option: `sector:mode`. The private-wager catalog
 * (`PrivateWagerInvite.tsx` → server `privateMatch.ts`) and the matchmaking
 * queue key both use this composite, so an ECLIPSE·SLAYER player can never be
 * dropped into a BLITZ·LMS match.
 */
export const onlineChoiceId = (choice: OnlineChoice): string => `${choice.sector}:${choice.mode}`;

/**
 * The inverse of {@link onlineChoiceId}. Needed because a private match can now
 * be started from the NAV BAR, where the sector+mode come from the INVITE
 * rather than from this lobby's picker — accepting an ECLIPSE·SLAYER invite
 * must not hand off whatever the local picker happens to be sitting on.
 * Returns null for anything not in the 2×2, so an unknown id starts nothing.
 */
export const onlineChoiceFromId = (id: string): OnlineChoice | null => {
  const [sector, mode] = id.split(':');
  if (sector !== 'eclipse' && sector !== 'blitz') return null;
  if (mode !== 'slayer' && mode !== 'lms') return null;
  return { sector, mode };
};

/**
 * ONLINE WORDING. Layout, animation and styling come from the practice
 * selector untouched; only these submode lines differ, so the agreed online
 * copy ("No winner, no loser." / "Nobody is crowned.") survives.
 *
 * Module scope on purpose: the selector memoises on this object identity, so
 * an inline literal would rebuild the merged table on every render.
 */
const ONLINE_COPY: Partial<Record<AsteroidsSectorId, AsteroidsSectorCopy>> = {
  eclipse: {
    submodes: {
      10: { desc: 'Points for every kill. No winner, no loser.' },
      11: { desc: 'Collapsing zones. Last hull alive wins.' },
    },
  },
  blitz: {
    submodes: {
      12: { desc: 'Ranked purely by kill count. Nobody is crowned.' },
      13: { desc: 'Last one left wins. Defence is a strategy.' },
    },
  },
};

// ---------------------------------------------------------------------------
// LOBBY
// ---------------------------------------------------------------------------

interface AsteroidsLobbyProps {
  /** ONLINE entry — always one of the four sector×mode options. */
  onFindGame: (choice: OnlineChoice) => void;
  onPlayComputer: (difficulty: number, mode: 'free_play' | 'slayer' | 'lms') => void;
  onExit: () => void;
}

/**
 * PRACTICE-ONLY mode pills. These feed the practice wager menu (Neon Bucks)
 * exactly as before, FREE PLAY included — the online path no longer reads
 * them at all.
 */
const PRACTICE_MODES: Array<{
  id: 'free_play' | 'slayer' | 'lms';
  icon: string;
  label: string;
  hint: string;
}> = [
  { id: 'free_play', icon: 'videogame_asset', label: 'Free Play', hint: 'Join anytime' },
  { id: 'slayer', icon: 'smart_toy', label: 'Slayer', hint: 'Kill count' },
  { id: 'lms', icon: 'trending_up', label: 'LAST MAN STANDING', hint: 'Last one standing' },
];

const AsteroidsLobby = ({
  onFindGame,
  onPlayComputer,
  onExit,
}: AsteroidsLobbyProps) => {
  /** 'cards' → the three entry cards; the other two are full-width pickers. */
  const [view, setView] = useState<'cards' | 'practice' | 'online'>('cards');
  const [selectedDifficulty, setSelectedDifficulty] = useState(1);
  const [selectedMode, setSelectedMode] = useState<'free_play' | 'slayer' | 'lms'>('free_play');

  // ONLINE: the difficulty code the shared selector speaks (10..13), and which
  // card asked for it. The selector owns its own drill-down state, so it always
  // reopens on the sector list with the confirm button disabled.
  const [onlineDifficulty, setOnlineDifficulty] = useState<number>(ASTEROIDS_DEFAULT_ONLINE_DIFFICULTY);
  const [onlineIntent, setOnlineIntent] = useState<'wager' | 'private'>('wager');
  // PRIVATE WAGER: invite-only match against a friend, in the picked option.
  const [showPrivateWager, setShowPrivateWager] = useState(false);

  /**
   * A private match started from a room this lobby did NOT open — the invitee
   * accepted from the nav-bar bell, a pop-up, or a friend's row, and the app
   * navigated here so that this component would be mounted and listening.
   * AsteroidsGame only mounts its match screen (and its
   * `freeplay:match_found` listener) once a match begins, so we hand off
   * through the SAME entry point the WAGER MATCH card uses — with the mode
   * from the INVITE, not from this lobby's picker.
   */
  usePrivateWagerStarted("asteroids", (mode) => {
    const choice = onlineChoiceFromId(mode);
    if (choice) onFindGame(choice);
  });
  const containerRef = useRef<HTMLDivElement>(null);

  /** The picked difficulty as the { sector, mode } pair the online path emits. */
  const onlineChoice: OnlineChoice = useMemo(
    () => asteroidsDifficultyToSectorMode(onlineDifficulty) ?? DEFAULT_ONLINE_CHOICE,
    [onlineDifficulty],
  );

  const openOnlinePicker = (intent: 'wager' | 'private') => {
    setOnlineIntent(intent);
    setView('online');
  };

  const handleConfirmOnline = () => {
    // Free play can never get here (the selector hides that sector online), but
    // refuse anything that is not one of the four rather than guess.
    const pair = asteroidsDifficultyToSectorMode(onlineDifficulty);
    if (!pair) return;
    setView('cards');
    if (onlineIntent === 'private') {
      setShowPrivateWager(true);
    } else {
      onFindGame(pair);
    }
  };

  /** Practice only — the difficulty selector never gates online play now. */
  const handleStartGame = () => {
    onPlayComputer(selectedDifficulty, selectedMode);
    setView('cards');
  };

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
            NEON ASTEROIDS
          </h1>
        </div>
        
        {/* Level progression — compact strip under the title. */}
        <LobbyLevelStrip />

                <div className="w-full">
          {view === 'cards' && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full text-left">
              <ParticleCard
                onClick={() => openOnlinePicker('wager')}
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
              {/* PRIVATE WAGER — same four sector×mode options as the public
                  queue; free play has no private match to start. */}
              <ParticleCard
                onClick={() => openOnlinePicker('private')}
                className="magic-bento-card magic-bento-card--border-glow px-8 py-6 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
              >
                <Swords className="w-8 h-8 text-zinc-400 group-hover:rotate-12 transition-transform" />
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
                onClick={() => setView('practice')}
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
          )}

          {/* WAGER / PRIVATE: the practice selector itself, minus free play.
              Same drill-down, same back link, same button strip — the only
              differences are the confirm label and the online submode copy. */}
          {view === 'online' && (
            <AsteroidsDifficultySelector
              selectedDifficulty={onlineDifficulty}
              onSelect={setOnlineDifficulty}
              onConfirm={handleConfirmOnline}
              onCancel={() => setView('cards')}
              includeFreeSector={false}
              confirmLabel={onlineIntent === 'private' ? 'Invite a Friend' : 'Find Match'}
              copy={ONLINE_COPY}
            />
          )}

          {view === 'practice' && (
            <AsteroidsDifficultySelector
              selectedDifficulty={selectedDifficulty}
              onSelect={setSelectedDifficulty}
              onConfirm={handleStartGame}
              onCancel={() => setView('cards')}
            />
          )}
        </div>
{view === 'cards' && (
          <>
          <div className="space-y-3">
            {/* These pills are the PRACTICE ruleset only — the online path
                picks its sector+mode in the drill-down selector above. */}
            <p className="text-[9px] font-mono tracking-[0.3em] uppercase text-white/25">
              Practice ruleset
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {PRACTICE_MODES.map((mode) => (
                <ParticleCard
                  key={mode.id}
                  onClick={() => setSelectedMode(mode.id)}
                  className={`magic-bento-card magic-bento-card--border-glow backdrop-blur-md p-5 rounded-xl border flex flex-col items-center gap-2 transition-all cursor-pointer ${selectedMode === mode.id ? 'border-[#00FFD1] shadow-[0_0_15px_rgba(0,255,209,0.5)]' : 'border-[#00FFD1]/40'}`}
                >
                  <div className="material-symbols-outlined text-[#00FFD1] text-2xl">
                    {mode.icon}
                  </div>
                  <p className="text-[10px] font-mono tracking-widest uppercase text-[#B1C5FF]/70">
                    {mode.label}
                  </p>
                  <p className="text-[8px] font-mono tracking-widest uppercase text-white/25">
                    {mode.hint}
                  </p>
                </ParticleCard>
              ))}
            </div>
          </div>
          {/* Shared lobby footer — the same PRACTICE / ONLINE / WAGER trio
              that closes every other arcade lobby. */}
          <LobbyModeTiles />
          </>
        )}
      </div>

      {/* Private-wager waiting room.
          AsteroidsGame only mounts the core (and its `freeplay:match_found`
          listener) once the player is in a match, so when the server starts
          the private match we hand off through the SAME entry point the
          WAGER MATCH card uses — with the SAME sector+mode. */}
      {showPrivateWager && (
        <PrivateWagerRoom
          gameKey="asteroids"
          mode={onlineChoiceId(onlineChoice)}
          onClose={() => setShowPrivateWager(false)}
          onStarted={() => onFindGame(onlineChoice)}
        />
      )}
    </div>
  );
};
export default AsteroidsLobby;
