/**
 * POST-GAME PROGRESSION — the "+XP / LEVEL UP / RANKED UP" overlays
 * =================================================================
 * Chained AFTER a results screen: the server's `match:progression` event
 * (captured by useMatchProgression) arrives a beat after the game's own end
 * event, and this component turns it into up to two staged full-screen
 * overlays:
 *
 *   XP stage    — always, when the match paid XP: a circular loader that
 *                 sweeps to the player's progress into their current level,
 *                 the "+150 XP" amount in the middle, and the big lobby-title
 *                 text ("LEVEL UP" when a boundary was crossed, "XP EARNED"
 *                 otherwise).
 *   RANK stage  — only when the match changed the rank badge (promotion):
 *                 the same big text saying "RANKED UP", a ring loader
 *                 animation, and the rank card (label + division bar) in the
 *                 new tier's colours.
 *
 * The big text is deliberately the exact class string every lobby h1 uses
 * (GameLobby.tsx etc.) so the moment reads like the arcade's own voice.
 *
 * Interaction contract: renders nothing until a payload exists; each stage
 * auto-advances, and a click skips ahead. When the last stage finishes it
 * calls onDone (the host clears the captured payload so a rematch cannot
 * replay it) and unmounts. z-[120] sits above both results screens
 * (NeonBucks z-[100], chess overlay z-50).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { MatchProgression } from '../../hooks/useGameSocket';

/** The lobby-title typography, verbatim (size stepped for an overlay). */
const BIG_TEXT =
  'text-5xl md:text-7xl font-black text-[#FFFFFD] drop-shadow-[0_0_20px_rgba(0,255,209,0.6)] uppercase tracking-tighter italic';

/** How long the overlay waits for the results screen to land first. */
const LEAD_IN_MS = 1400;
const XP_STAGE_MS = 3400;
const RANK_STAGE_MS = 3600;

/** SVG circle loader that sweeps from a start pct to an end pct. */
function CircleLoader({
  fromPct,
  toPct,
  color,
  children,
}: {
  fromPct: number;
  toPct: number;
  color: string;
  children: React.ReactNode;
}) {
  const R = 84;
  const C = 2 * Math.PI * R;
  return (
    <div className="relative h-52 w-52">
      <svg viewBox="0 0 208 208" className="h-full w-full -rotate-90">
        <circle cx="104" cy="104" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="10" />
        <motion.circle
          cx="104"
          cy="104"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 10px ${color})` }}
          strokeDasharray={C}
          initial={{ strokeDashoffset: C * (1 - Math.max(0, Math.min(100, fromPct)) / 100) }}
          animate={{ strokeDashoffset: C * (1 - Math.max(0, Math.min(100, toPct)) / 100) }}
          transition={{ duration: 1.6, ease: [0.16, 1, 0.3, 1], delay: 0.5 }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

/** Spinning ring — the "loader animation" behind the rank card. */
function RankLoaderRing({ color }: { color: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      {[0, 1].map((i) => (
        <motion.div
          key={i}
          className="absolute rounded-full border-2"
          style={{
            width: 240 + i * 46,
            height: 240 + i * 46,
            borderColor: `${color}${i === 0 ? '55' : '2e'}`,
            borderTopColor: color,
          }}
          animate={{ rotate: 360 }}
          transition={{ duration: 2.4 + i * 1.2, repeat: Infinity, ease: 'linear' }}
        />
      ))}
    </div>
  );
}

export function PostGameProgression({
  progression,
  onDone,
}: {
  progression: MatchProgression | null;
  onDone: () => void;
}) {
  type Stage = 'idle' | 'xp' | 'rank' | 'done';
  const [stage, setStage] = useState<Stage>('idle');

  const xp = progression?.xp ?? null;
  const rank = progression?.rank ?? null;
  // "Ranked up" strictly means the badge improved. Demotions get no
  // ceremony — the results screen already told that story.
  const rankedUp = !!rank && rank.promoted;

  const stages = useMemo<Stage[]>(() => {
    const s: Stage[] = [];
    if (xp && xp.amount > 0) s.push('xp');
    if (rankedUp) s.push('rank');
    return s;
  }, [xp, rankedUp]);

  // Payload arrival → lead-in → run the stages → done exactly once.
  useEffect(() => {
    if (!progression) {
      setStage('idle');
      return;
    }
    if (stages.length === 0) {
      onDone();
      return;
    }
    const t = setTimeout(() => setStage(stages[0]), LEAD_IN_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progression]);

  const advance = React.useCallback(() => {
    setStage((current) => {
      const idx = stages.indexOf(current as Stage);
      const next = idx >= 0 && idx + 1 < stages.length ? stages[idx + 1] : 'done';
      return next;
    });
  }, [stages]);

  useEffect(() => {
    if (stage === 'xp' || stage === 'rank') {
      const t = setTimeout(advance, stage === 'xp' ? XP_STAGE_MS : RANK_STAGE_MS);
      return () => clearTimeout(t);
    }
    if (stage === 'done') {
      onDone();
      setStage('idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, advance]);

  const bandColor = xp?.level.color ?? '#00FFD1';

  return (
    <AnimatePresence>
      {stage === 'xp' && xp && (
        <motion.div
          key="xp"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45 }}
          onClick={advance}
          className="fixed inset-0 z-[120] flex cursor-pointer flex-col items-center justify-center gap-8 bg-black/92 px-6 backdrop-blur-md"
        >
          <motion.h2
            initial={{ opacity: 0, y: 26, scale: 0.92, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className={`${BIG_TEXT} text-center`}
          >
            {xp.leveledUp ? 'Level Up' : 'XP Earned'}
          </motion.h2>

          <CircleLoader
            // A crossed boundary sweeps from empty (the new level starts
            // fresh); otherwise from where the bar stood before the match.
            fromPct={xp.leveledUp ? 0 : Math.max(0, xp.level.progressPct - 1)}
            toPct={xp.level.progressPct}
            color={bandColor}
          >
            <div
              className="font-black italic text-3xl tracking-tighter"
              style={{ color: bandColor, textShadow: `0 0 18px ${bandColor}66` }}
            >
              +{xp.amount} XP
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.3em] text-white/60">
              {xp.level.label}
            </div>
          </CircleLoader>

          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-white/40">
            {xp.leveledUp
              ? `${xp.levelBefore} → ${xp.levelAfter} · ${xp.level.band}`
              : xp.level.isMaxLevel
                ? 'Max level'
                : `${xp.level.xpToNextLevel.toLocaleString('en-US')} XP to next level`}
          </div>
        </motion.div>
      )}

      {stage === 'rank' && rank && (
        <motion.div
          key="rank"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45 }}
          onClick={advance}
          className="fixed inset-0 z-[120] flex cursor-pointer flex-col items-center justify-center gap-8 bg-black/92 px-6 backdrop-blur-md"
        >
          <motion.h2
            initial={{ opacity: 0, y: 26, scale: 0.92, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className={`${BIG_TEXT} text-center`}
          >
            Ranked Up
          </motion.h2>

          <div className="relative flex items-center justify-center">
            <RankLoaderRing color={rank.rank.color} />
            {/* The rank card — same shell as the menu's Current Rank card. */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.4, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className="relative z-10 w-64 rounded-xl border border-[#00ffd1]/20 bg-black/70 p-5 backdrop-blur-sm"
            >
              <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/40">
                {rank.rankBefore.label}
              </div>
              <div
                className="mt-1 text-2xl font-black uppercase italic tracking-tighter"
                style={{ color: rank.rank.color, textShadow: `0 0 18px ${rank.rank.color}66` }}
              >
                {rank.rank.label}
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-black/60 ring-1 ring-inset ring-white/10">
                <motion.div
                  className="h-full rounded-full"
                  style={{
                    background: rank.rank.gradient || rank.rank.color,
                    boxShadow: `0 0 10px ${rank.rank.color}`,
                  }}
                  initial={{ width: '0%' }}
                  animate={{ width: `${Math.max(4, rank.rank.progressPct)}%` }}
                  transition={{ delay: 0.8, duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
                />
              </div>
              <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.25em] text-[#00FFD1]/70">
                +{rank.rpChange} RP
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
