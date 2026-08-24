import { AnimatePresence, motion } from 'motion/react';
import { Menu, Volume2, VolumeX } from 'lucide-react';
import { ZONE_COLOR } from '../ring';
import { goals } from '../shootout';
import { useGame } from '../store';
import { flipDir } from '../types';
import { ScorePips } from './ScorePips';

function KeyChip({ k, label, active = false }: { k: string; label: string; active?: boolean }) {
  return (
    <div
      className={`backdrop-blur-md border px-4 py-2.5 rounded-xl flex items-center gap-3 transition-colors ${
        active ? 'bg-[#00FFD1]/15 border-[#00FFD1]/60' : 'bg-black/40 border-white/10'
      }`}
    >
      <span
        className={`w-7 h-7 rounded-md border flex items-center justify-center font-black text-sm ${
          active ? 'border-[#00FFD1] text-[#00FFD1]' : 'border-white/25 text-white/80'
        }`}
      >
        {k}
      </span>
      <span className="text-[10px] font-mono uppercase tracking-widest text-white/60">{label}</span>
    </div>
  );
}

const ZONE_CHIP: Record<string, { text: string; color: string }> = {
  green: { text: 'PERFECT', color: ZONE_COLOR.green },
  orange: { text: 'SCUFFED', color: ZONE_COLOR.orange },
  red: { text: 'MISTIMED', color: ZONE_COLOR.red },
};

export function Hud() {
  const phase = useGame((s) => s.phase);
  const turn = useGame((s) => s.turn);
  const round = useGame((s) => s.round);
  const suddenDeath = useGame((s) => s.suddenDeath);
  const shootout = useGame((s) => s.shootout);
  const result = useGame((s) => s.result);
  const playerGuess = useGame((s) => s.playerGuess);
  const muted = useGame((s) => s.muted);
  const togglePause = useGame((s) => s.togglePause);
  const toggleMute = useGame((s) => s.toggleMute);

  const inPlay = phase !== 'over';
  const striking = turn === 'player';
  const keeperGuess = flipDir(playerGuess);

  return (
    <div className="absolute inset-0 pointer-events-none z-[60]">
      {/* ---- top left: the VOLLEY-style score tally — big italic numbers
          split by a slash, drop-shadow glow, with the per-kick pips playing
          the role of Volley's progress bars underneath each side. (The old
          compact tracker + the top-right leaderboard card were replaced by
          this per request — one tally, same look as Neon Volley's.) */}
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        className="absolute top-6 left-6 backdrop-blur-md bg-black/40 border border-[#00FFD1]/20 px-6 py-4 rounded-2xl"
      >
        <div className="flex items-center gap-8">
          <div className="flex flex-col items-center">
            <span className="text-4xl md:text-6xl font-black text-white italic drop-shadow-[0_0_30px_rgba(255,255,255,0.4)] leading-none">
              {goals(shootout, 'player')}
            </span>
            <span className="mt-1.5 text-[10px] font-mono uppercase tracking-widest text-[#00FFD1]">You</span>
            <div className="mt-2">
              <ScorePips shootout={shootout} side="player" active={inPlay} />
            </div>
          </div>
          <span className="text-2xl text-[#00FFD1] font-black italic opacity-40">/</span>
          <div className="flex flex-col items-center">
            <span className="text-4xl md:text-6xl font-black text-white italic drop-shadow-[0_0_30px_rgba(255,255,255,0.4)] leading-none">
              {goals(shootout, 'ai')}
            </span>
            <span className="mt-1.5 max-w-24 truncate text-[10px] font-mono uppercase tracking-widest text-[#FF0080]">
              {useGame.getState().online?.opponent ?? 'AI'}
            </span>
            <div className="mt-2">
              <ScorePips shootout={shootout} side="ai" active={inPlay} />
            </div>
          </div>
        </div>
      </motion.div>

      {/* ---- top center: round + role */}
      <motion.div
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        className="absolute top-6 left-1/2 -translate-x-1/2 text-center"
      >
        <div className="backdrop-blur-xl bg-black/60 border border-white/10 px-8 py-3.5 rounded-3xl shadow-2xl">
          <p className={`text-[10px] font-mono uppercase tracking-[0.35em] ${suddenDeath ? 'text-[#FF0080]' : 'text-white/40'}`}>
            {suddenDeath ? 'Sudden Death' : `Round ${round} of 5`}
          </p>
          <p className="text-2xl font-black italic uppercase tracking-tighter text-white leading-tight">
            {striking ? (
              <>You <span className="text-[#00FFD1]">strike</span></>
            ) : (
              <>You <span className="text-[#FF0080]">keep</span></>
            )}
          </p>
        </div>
      </motion.div>

      {/* ---- bottom center: contextual keybinds */}
      <AnimatePresence>
        {(phase === 'aim' || phase === 'guard') && (
          <motion.div
            key={phase}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3"
          >
            {phase === 'aim' ? (
              <>
                <div className="flex gap-2">
                  <KeyChip k="A" label="Top left" />
                  <KeyChip k="W" label="Down the middle" />
                  <KeyChip k="D" label="Top right" />
                </div>
                <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-white/45 backdrop-blur-md bg-black/30 px-4 py-1.5 rounded-full">
                  Strike on <span className="text-[#2bff8f] font-bold">green</span> — wait too long and it pulses faster
                </p>
              </>
            ) : (
              <>
                <div className="flex gap-2">
                  <KeyChip k="A" label="Dive left" active={keeperGuess === 'left'} />
                  <KeyChip k="·" label="Stay middle" active={keeperGuess === 'middle'} />
                  <KeyChip k="D" label="Dive right" active={keeperGuess === 'right'} />
                </div>
                <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-white/45 backdrop-blur-md bg-black/30 px-4 py-1.5 rounded-full">
                  Commit before the boot lands — do nothing to guard the middle
                </p>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---- bottom right: mute / pause */}
      <div className="absolute bottom-6 right-6 flex gap-3 pointer-events-auto">
        <button
          onClick={toggleMute}
          className="p-3.5 bg-white/5 border border-white/10 rounded-2xl text-[#00FFD1] hover:bg-[#00FFD1]/10 hover:border-[#00FFD1]/50 transition-all shadow-2xl active:scale-90 cursor-pointer"
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <VolumeX className="w-5 h-5 text-red-500" /> : <Volume2 className="w-5 h-5" />}
        </button>
        <button
          onClick={togglePause}
          className="p-3.5 bg-white/5 border border-white/10 rounded-2xl text-[#00FFD1] hover:bg-[#00FFD1]/10 hover:border-[#00FFD1]/50 transition-all shadow-2xl active:scale-90 cursor-pointer"
          title="Pause (Esc)"
        >
          <Menu className="w-5 h-5" />
        </button>
      </div>

      {/* ---- center banners: round intro & kick result */}
      <AnimatePresence>
        {phase === 'intro' && (
          <motion.div
            key={`intro-${round}-${turn}`}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-0 flex flex-col items-center justify-center"
          >
            <p className={`font-mono text-sm tracking-[0.5em] uppercase mb-3 ${suddenDeath ? 'text-[#FF0080]' : 'text-[#00FFD1]/70'}`}>
              {suddenDeath ? 'Sudden death' : `Round ${round}`}
            </p>
            <p className="text-6xl md:text-7xl font-black italic uppercase tracking-tighter text-white drop-shadow-[0_0_35px_rgba(0,255,209,0.35)]">
              {striking ? 'You strike' : 'You keep'}
            </p>
          </motion.div>
        )}

        {phase === 'result' && result && (
          <motion.div
            key="result"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.08 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-0 flex flex-col items-center justify-center"
          >
            {result.zone && (
              <span
                className="mb-4 px-4 py-1.5 rounded-full border font-mono text-[11px] uppercase tracking-[0.35em]"
                style={{ color: ZONE_CHIP[result.zone].color, borderColor: ZONE_CHIP[result.zone].color }}
              >
                {ZONE_CHIP[result.zone].text}
              </span>
            )}
            <p
              className={`text-7xl md:text-8xl font-black italic uppercase tracking-tighter ${
                result.good
                  ? 'text-[#00FFD1] drop-shadow-[0_0_50px_rgba(0,255,209,0.5)]'
                  : 'text-[#FF0080] drop-shadow-[0_0_50px_rgba(255,0,128,0.5)]'
              }`}
            >
              {result.title}
            </p>
            <p className="mt-3 text-white/60 font-mono text-xs uppercase tracking-[0.3em]">{result.sub}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
