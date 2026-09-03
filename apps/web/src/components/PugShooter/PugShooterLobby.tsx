import React, { useRef, useState } from "react";
import { LobbyLevelStrip } from '../common/LobbyLevelStrip';
import { ChevronRight, Cpu, Globe, Settings, Swords, X } from "lucide-react";
import { DifficultySelector } from "../common/DifficultySelector";
import { LibraryBlob } from "../glass/LibraryBlob";
import { ParticleCard, GlobalSpotlight } from "../glass/MagicGameTile";
import PrivateWagerRoom from "../social/PrivateWagerRoom";
import LobbyModeTiles from "../common/LobbyModeTiles";
import PugShooterMapSelect from "./PugShooterMapSelect";
import { MAPS, type PugShooterMap } from "./pugShooterMaps";
import {
  loadPugShooterOptions,
  savePugShooterOptions,
  OPTION_RANGES,
  type PugShooterOptions,
} from "./pugShooterOptions";

export type PugShooterMode = "ffa" | "duel" | "duo";
// The map union lives in pugShooterMaps.ts (shared with the selection
// page); re-exported here so PugShooterGame's imports stay unchanged.
export type { PugShooterMap } from "./pugShooterMaps";
export type PugShooterDifficulty = "easy" | "normal" | "hard";

/** Everything the game's boot needs — serialized onto the iframe query string. */
export interface PugShooterMatchConfig {
  mode: PugShooterMode;
  map: PugShooterMap;
  difficulty: PugShooterDifficulty;
}

const MODES: { id: PugShooterMode; label: string; detail: string }[] = [
  { id: "ffa", label: "Free For All", detail: "you + 5 bots · first to 15" },
  { id: "duel", label: "1v1 Duel", detail: "one sharp bot · first to 10" },
  { id: "duo", label: "2v2 Teams", detail: "you + an ally · first team to 20" },
];

// Mirrors DIFFICULTIES in the game's src/difficulty.js — the pill value is just an
// index into this list, since the shared selector speaks numbers.
const DIFFICULTY_TIERS: { id: PugShooterDifficulty; label: string; caption: string }[] = [
  { id: "easy", label: "Easy", caption: "Bots land half as many shots · a headshot every 100 body shots" },
  { id: "normal", label: "Normal", caption: "Bots shoot like Hard · a headshot every 10 body shots" },
  { id: "hard", label: "Hard", caption: "Off the leash · any shot can take your head off" },
];

interface PugShooterLobbyProps {
  /** ONLINE: enter the queue — the parent shows SEARCHING FOR ONLINE MATCH.
   *  Free, no stake; the chosen mode/map/difficulty boot the matched round. */
  onFindGame: (config: PugShooterMatchConfig) => void;
  /** PRACTICE: boot the local bot match immediately. Behaviour unchanged. */
  onPlayComputer: (config: PugShooterMatchConfig) => void;
  onExit: () => void;
  /** Matchmaking refusal to surface (e.g. account setup unfinished). */
  error?: string | null;
}

// One slider row of the lobby Options panel, styled after the arcade's volume config.
const OPTION_SLIDERS: {
  key: keyof PugShooterOptions;
  label: string;
  format: (v: number) => string;
}[] = [
  { key: "sensitivity", label: "Sensitivity", format: (v) => v.toFixed(2) },
  { key: "fov", label: "Field of View", format: (v) => `${Math.round(v)}°` },
  { key: "stretch", label: "Stretch", format: (v) => `${v.toFixed(2)}×` },
  { key: "volume", label: "Volume", format: (v) => `${Math.round(v * 100)}%` },
];

const PugShooterLobby = ({ onFindGame, onPlayComputer, error }: PugShooterLobbyProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<PugShooterMode>("ffa");
  const [map, setMap] = useState<PugShooterMap>("city");
  // TWO-STEP FLOW: this screen picks mode/difficulty/how-to-play; NEXT
  // (bottom) advances to the full-screen map page, whose CONFIRM launches
  // the chosen action. The map never appears on this screen.
  const [showMapSelect, setShowMapSelect] = useState(false);
  // Which launch path CONFIRM on the map page will run. The three cards
  // below select this instead of launching directly.
  const [action, setAction] = useState<"online" | "private" | "practice">("online");
  const [difficultyIndex, setDifficultyIndex] = useState(1); // normal
  const [showOptions, setShowOptions] = useState(false);
  // PRIVATE WAGER: invite-only round against a friend, in the mode selected
  // above. PugShooterGame's `useOnlineLobbyQueue` keeps its `lobbyGame:start`
  // listener mounted while this lobby is on screen, so the started match takes
  // over on its own — hence no `onStarted` handoff below.
  const [showPrivateWager, setShowPrivateWager] = useState(false);
  // Shared with the game via localStorage: the iframe reads these at boot, and its own
  // pause-screen Options writes back to the same entry.
  const [options, setOptions] = useState<PugShooterOptions>(loadPugShooterOptions);

  const updateOption = (key: keyof PugShooterOptions, value: number) => {
    setOptions((prev) => {
      const next = { ...prev, [key]: value };
      savePugShooterOptions(next);
      return next;
    });
  };

  // Esc closes the options popup, matching the in-game panel's feel.
  React.useEffect(() => {
    if (!showOptions) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowOptions(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showOptions]);

  return (
    // NON-SCROLLABLE by design: every control below is sized so the whole
    // lobby fits one viewport (the old overflow-y-auto existed for an
    // inline Options panel that is a fixed popup now). The other-games tile
    // row is the pressure valve — it hides on short viewports (bottom).
    <div className="h-full min-h-0 bg-[#081616] flex flex-col items-center p-4 relative overflow-hidden">
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

      <div ref={containerRef} className="relative z-10 text-center space-y-4 max-w-2xl w-full my-auto py-4">
        <div className="space-y-1">
          {/* Smaller than the sibling lobbies on purpose: this page must
              hold mode + cards + difficulty + NEXT without scrolling, so
              the title pays first. nowrap keeps it on one row. */}
          <h1 className="text-4xl md:text-5xl font-black text-[#FFFFFD] drop-shadow-[0_0_20px_rgba(0,255,209,0.6)] uppercase tracking-tighter italic whitespace-nowrap">
            NEON PUG SHOOTER
          </h1>
          <p className="text-[10px] font-mono tracking-[0.3em] uppercase text-[#B1C5FF]/50">
            third person · stretched fov · bunny hop
          </p>
        </div>
        
        {/* Level progression — compact strip under the title. */}
        <LobbyLevelStrip />

        <div className="space-y-3">
          {/* Mode only — the MAP is deliberately absent from this screen:
              it is step two of the flow, the full-screen selection page the
              NEXT button (bottom) navigates to. */}
          <div className="flex flex-col items-center gap-2">
            <p className="text-[10px] font-mono tracking-[0.3em] uppercase text-[#B1C5FF]/50">
              Select Mode
            </p>
            <div className="flex gap-2 p-1 bg-[#111E1E]/80 border border-[#00FFD1]/20 rounded-lg backdrop-blur-md">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={`px-4 py-2 rounded-md text-[10px] font-bold uppercase tracking-widest transition-all ${
                    mode === m.id
                      ? "bg-[#00FFD1] text-[#081616] shadow-[0_0_15px_rgba(0,255,209,0.5)]"
                      : "text-[#B1C5FF]/50 hover:text-[#B1C5FF]"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="text-[9px] font-mono tracking-widest uppercase text-[#B1C5FF]/40">
              {MODES.find((m) => m.id === mode)?.detail}
            </p>
          </div>
        </div>

        <div className="w-full">
          {/* HOW-TO-PLAY cards — SELECTORS now, not launchers: the choice is
              held in `action` and executed by the map page's CONFIRM. The
              selected card keeps the neon ring; unselected ones dim. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 w-full text-left">
            <ParticleCard
              onClick={() => setAction("online")}
              aria-pressed={action === "online"}
              className={`magic-bento-card magic-bento-card--border-glow px-6 py-4 bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] rounded-2xl hover:scale-[1.02] active:scale-[0.98] transition-all flex flex-col items-center justify-center gap-2 group relative overflow-hidden cursor-pointer ${
                action === "online"
                  ? "ring-2 ring-[#00FFD1] ring-offset-2 ring-offset-[#081616] shadow-[0_0_50px_rgba(0,255,209,0.3)]"
                  : "opacity-60 hover:opacity-90"
              }`}
            >
              <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>
              <Globe className="w-6 h-6 group-hover:rotate-12 transition-transform" />
              <div className="text-center">
                <span className="block font-black text-base uppercase tracking-tighter italic leading-none">Wager Match</span>
                <span className="block text-[8px] opacity-60 font-bold tracking-widest mt-1">
                  GLOBAL WAGER ARENA
                </span>
              </div>
            </ParticleCard>
            {/* PRIVATE WAGER — new card (this lobby has no local co-op to
                replace), styled exactly like Practice per the contract. */}
            <ParticleCard
              onClick={() => setAction("private")}
              aria-pressed={action === "private"}
              className={`magic-bento-card magic-bento-card--border-glow px-6 py-4 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-2 group relative overflow-hidden cursor-pointer ${
                action === "private"
                  ? "ring-2 ring-[#00FFD1] ring-offset-2 ring-offset-[#081616] border-[#00FFD1]"
                  : "opacity-60 hover:opacity-90"
              }`}
            >
              <Swords className="w-6 h-6 text-zinc-400 group-hover:rotate-12 transition-transform group-hover:text-[#00FFD1]" />
              <div className="text-center">
                <span className="block font-black text-base uppercase tracking-tighter italic leading-none">
                  Private Wager
                </span>
                <span className="block text-[8px] text-white/40 font-bold tracking-widest mt-1">
                  INVITE A FRIEND
                </span>
              </div>
            </ParticleCard>
            <ParticleCard
              onClick={() => setAction("practice")}
              aria-pressed={action === "practice"}
              className={`magic-bento-card magic-bento-card--border-glow px-6 py-4 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-2 group relative overflow-hidden cursor-pointer ${
                action === "practice"
                  ? "ring-2 ring-[#00FFD1] ring-offset-2 ring-offset-[#081616] border-[#00FFD1]"
                  : "opacity-60 hover:opacity-90"
              }`}
            >
              <Cpu className="w-6 h-6 text-zinc-400 group-hover:rotate-12 transition-transform" />
              <div className="text-center">
                <span className="block font-black text-base uppercase tracking-tighter italic leading-none">
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

        {/* Bot difficulty — applies to every mode; bots fill each side */}
        <div className="w-full max-w-xl mx-auto px-5 py-3 rounded-2xl border border-[#00FFD1]/25 bg-[#041010]/80">
          <DifficultySelector
            tiers={DIFFICULTY_TIERS.map((t, i) => ({ id: t.id, label: t.label, value: i }))}
            value={difficultyIndex}
            onChange={setDifficultyIndex}
            title="Bot Difficulty"
            caption={DIFFICULTY_TIERS[difficultyIndex].caption}
          />
        </div>

        {/* Options + NEXT share one row (vertical space is the budget on a
            no-scroll page). Options opens the fixed popup — the iframe reads
            those values at boot and the in-game pause screen edits the same
            localStorage entry, so the two stay in sync. NEXT advances to the
            full-screen map page, whose CONFIRM launches the selected action. */}
        <div className="w-full max-w-xl mx-auto flex items-center gap-3">
          <button
            onClick={() => setShowOptions(true)}
            title="Game Options"
            className="shrink-0 inline-flex items-center gap-2 px-4 py-3.5 rounded-2xl border text-[10px] font-bold uppercase tracking-widest transition-all cursor-pointer backdrop-blur-md border-[#00FFD1]/40 text-[#B1C5FF]/70 hover:text-[#B1C5FF] hover:border-[#00FFD1]/70"
          >
            <Settings className="w-4 h-4" />
            Options
          </button>
          <button
            onClick={() => setShowMapSelect(true)}
            className="flex-1 flex items-center justify-center gap-3 px-8 py-3 bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] rounded-2xl font-black text-base uppercase tracking-tighter italic shadow-[0_0_40px_rgba(0,255,209,0.35)] hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer"
          >
            Next — Select Map
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        {/* The other-games strip is the first thing sacrificed on short
            viewports — the lobby's own controls must never scroll. */}
        <div className="hidden [@media(min-height:860px)]:block">
          <LobbyModeTiles className="mt-0" />
        </div>
      </div>

      {/* Centered options popup */}
      {showOptions && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6" role="dialog" aria-modal="true">
          {/* click-away backdrop */}
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setShowOptions(false)}
          />
          <div className="relative w-full max-w-md bg-[#041010]/95 border border-[#00FFD1]/30 rounded-2xl p-6 shadow-[0_0_60px_rgba(0,255,209,0.15)] space-y-5 text-left font-mono">
            <div className="flex items-center justify-between">
              <h3 className="text-white font-black uppercase text-xs tracking-[0.25em] flex items-center gap-2">
                <Settings className="w-4 h-4 text-[#00FFD1]" />
                Game Options
              </h3>
              <button
                onClick={() => setShowOptions(false)}
                title="Close"
                className="p-1.5 rounded-full border border-[#00FFD1]/30 text-white/70 hover:text-white hover:border-[#00FFD1] hover:bg-[#00FFD1]/10 transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {OPTION_SLIDERS.map(({ key, label, format }) => (
              <div key={key} className="space-y-2">
                <div className="flex justify-between text-[10px] uppercase tracking-widest text-white/50">
                  <span>{label}</span>
                  <span className="text-[#00FFD1]">{format(options[key])}</span>
                </div>
                <input
                  type="range"
                  min={OPTION_RANGES[key].min}
                  max={OPTION_RANGES[key].max}
                  step={OPTION_RANGES[key].step}
                  value={options[key]}
                  onChange={(e) => updateOption(key, parseFloat(e.target.value))}
                  className="w-full accent-[#00FFD1] bg-[#111E1E] rounded-lg appearance-none h-1 cursor-pointer"
                />
              </div>
            ))}

            <p className="text-[9px] tracking-widest uppercase text-[#B1C5FF]/40 pt-1 text-center">
              Applies at match start · also editable in-game from pause
            </p>
          </div>
        </div>
      )}

      {/* STEP TWO — the full-screen map selection page. CONFIRM here is the
          LAUNCH: it runs whichever action the lobby's cards selected, with
          the freshly picked map (built inline — setMap hasn't flushed yet).
          Back/Esc returns to the lobby with everything intact. */}
      {showMapSelect && (
        <PugShooterMapSelect
          initialMap={map}
          confirmLabel={
            action === "online"
              ? "Find Match"
              : action === "private"
                ? "Open Private Room"
                : "Start Practice"
          }
          onConfirm={(picked) => {
            setMap(picked);
            setShowMapSelect(false);
            const chosen: PugShooterMatchConfig = {
              mode,
              map: picked,
              difficulty: DIFFICULTY_TIERS[difficultyIndex].id,
            };
            if (action === "online") onFindGame(chosen);
            else if (action === "practice") onPlayComputer(chosen);
            else setShowPrivateWager(true);
          }}
          onBack={() => setShowMapSelect(false)}
        />
      )}

      {/* Private-wager waiting room. The room seats 2 in every Pug Shooter
          mode (that is what the server's queue actually pairs), so it renders
          the 1v1 diagonal layout. */}
      {showPrivateWager && (
        <PrivateWagerRoom
          gameKey="pugshooter"
          /* FFA capacity is PER MAP (Neon Suburbs 30 / Cold Storage 10), so
             the wire mode carries the selected map for FFA rooms. */
          mode={mode === 'ffa' ? `ffa:${map}` : mode}
          onClose={() => setShowPrivateWager(false)}
        />
      )}
    </div>
  );
};

export default PugShooterLobby;
