// src/components/Cells/CellsDifficultySelector.tsx
//
// The drill-down sector picker. It is the SINGLE source of truth for the
// practice / wager / private layout: a vertical stack of sector cards →
// (click) → that sector's submode list with a "Back to Sectors" link →
// an ABORT + confirm strip.
//
// Practice renders it with no extra props and behaves exactly as it always
// has. Online (wager) and private-invite call sites render the same component
// with `includeFreeSector={false}` (so FREE SECTOR / INFINITE is unreachable)
// and their own `confirmLabel`, and translate the difficulty number the
// selector speaks into whatever shape their transport needs using the helpers
// exported at the bottom of this file.
import React, { useMemo, useState } from 'react';
import { Shield, ChevronRight, X, Target, Skull, Zap, Swords, ChevronLeft } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

/** Sector ids as the selector knows them. 'free' is practice-only. */
export type CellsSectorId = 'free' | 'eclipse' | 'blitz';
/** The two sectors reachable from wager + private. */
export type CellsOnlineSectorId = 'eclipse' | 'blitz';
/** Match modes inside an online sector. */
export type CellsMatchMode = 'slayer' | 'lms';
/** Composite mode id the server's privateMatch CATALOG is keyed by. */
export type CellsCompositeMode = 'eclipse:slayer' | 'eclipse:lms' | 'blitz:slayer' | 'blitz:lms';

type SectorIcon = React.ComponentType<{ className?: string }>;

interface SubmodeDef {
  id: number;
  name: string;
  icon: SectorIcon;
  desc: string;
}

interface SectorDef {
  id: CellsSectorId;
  name: string;
  icon: SectorIcon;
  desc: string;
  submodes: SubmodeDef[];
}

/**
 * Optional per-sector copy override. Purely textual — the layout, animation
 * and styling are identical whether or not it is supplied. Call sites that
 * have their own agreed wording (e.g. the online slayer lines "No winner, no
 * loser." / "Nobody is crowned.") pass it here instead of cloning the markup.
 */
export interface CellsSectorCopy {
  name?: string;
  desc?: string;
  /** Keyed by difficulty id (10 | 11 | 12 | 13, or 1 for INFINITE). */
  submodes?: Partial<Record<number, { name?: string; desc?: string }>>;
}

interface CellsDifficultySelectorProps {
  selectedDifficulty: number;
  onSelect: (difficulty: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * Whether the FREE SECTOR (INFINITE, difficulty 1) card is offered.
   * Defaults to TRUE so practice is unchanged; wager + private pass FALSE.
   */
  includeFreeSector?: boolean;
  /** Label on the confirm button. Defaults to practice's 'Initialize AI'. */
  confirmLabel?: string;
  /** Optional textual overrides, per sector id. */
  copy?: Partial<Record<CellsSectorId, CellsSectorCopy>>;
}

const CATEGORIES: SectorDef[] = [
  {
    id: 'free',
    name: 'FREE SECTOR',
    icon: Shield,
    desc: 'Unrestricted airspace with various engagement parameters.',
    submodes: [
      { id: 1, name: 'INFINITE', icon: Shield, desc: 'Pure kill cultivation. No boundaries, no limits.' },
    ]
  },
  {
    id: 'eclipse',
    name: 'ECLIPSE',
    icon: Target,
    desc: 'Dynamic safe zones. Move or succumb to the void.',
    submodes: [
      { id: 10, name: 'SLAYER', icon: Target, desc: 'Standard zone dynamics. Navigate the debris.' },
      { id: 11, name: 'LAST MAN STANDING', icon: Zap, desc: 'Accelerated collapsing zones. Speed is armor.' },
    ]
  },
  {
    id: 'blitz',
    name: 'BLITZ',
    icon: Skull,
    desc: 'The ultimate survival test. Shrinking hull integrity field.',
    submodes: [
      { id: 12, name: 'SLAYER', icon: Swords, desc: 'Final standoff. Rank purely by kill count.' },
      { id: 13, name: 'LAST MAN STANDING', icon: Skull, desc: 'Last one left wins. Defensive strategy required.' },
    ]
  },
];

const applyCopy = (
  sectors: SectorDef[],
  copy?: Partial<Record<CellsSectorId, CellsSectorCopy>>,
): SectorDef[] => {
  if (!copy) return sectors;
  return sectors.map((sector) => {
    const override = copy[sector.id];
    if (!override) return sector;
    return {
      ...sector,
      name: override.name ?? sector.name,
      desc: override.desc ?? sector.desc,
      submodes: sector.submodes.map((sub) => {
        const subOverride = override.submodes?.[sub.id];
        if (!subOverride) return sub;
        return {
          ...sub,
          name: subOverride.name ?? sub.name,
          desc: subOverride.desc ?? sub.desc,
        };
      }),
    };
  });
};

const CellsDifficultySelector = ({
  selectedDifficulty,
  onSelect,
  onConfirm,
  onCancel,
  includeFreeSector = true,
  confirmLabel = 'Initialize AI',
  copy,
}: CellsDifficultySelectorProps) => {
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const sectors = useMemo(
    () => applyCopy(includeFreeSector ? CATEGORIES : CATEGORIES.filter(c => c.id !== 'free'), copy),
    [includeFreeSector, copy],
  );

  const currentCategory = sectors.find(c => c.id === activeCategory);

  return (
    <div className="w-full max-w-xl mx-auto space-y-6">
      <AnimatePresence mode="wait">
        {!activeCategory ? (
          <motion.div
            key="categories"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="grid grid-cols-1 gap-3"
          >
            {sectors.map((cat) => (
              <button
                key={cat.id}
                onClick={() => {
                  setActiveCategory(cat.id);
                  if (cat.submodes.length > 0) {
                    onSelect(cat.submodes[0].id);
                  }
                }}
                className="flex items-center gap-6 p-5 rounded-2xl border-2 border-white/5 bg-[#111E1E]/60 hover:border-[#00FFD1]/40 hover:bg-[#00FFD1]/5 transition-all text-left relative overflow-hidden group"
              >
                <div className="p-3 rounded-xl bg-white/5 text-[#00FFD1]">
                  <cat.icon className="w-6 h-6" />
                </div>
                <div className="flex-1">
                  <h3 className="font-black italic text-lg tracking-wider text-white uppercase">
                    {cat.name}
                  </h3>
                  <p className="text-[10px] font-mono text-white/40 uppercase tracking-widest mt-1">
                    {cat.desc}
                  </p>
                </div>
                <ChevronRight className="w-6 h-6 text-white/20 group-hover:text-[#00FFD1] transition-colors" />
              </button>
            ))}
          </motion.div>
        ) : (
          <motion.div
            key="submodes"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-4"
          >
            <button
              onClick={() => setActiveCategory(null)}
              className="flex items-center gap-2 text-xs font-mono text-[#00FFD1] hover:opacity-70 transition-all uppercase tracking-widest mb-2"
            >
              <ChevronLeft className="w-4 h-4" /> Back to Sectors
            </button>

            <div className="grid grid-cols-1 gap-3">
              {currentCategory?.submodes.map((sub) => (
                <button
                  key={sub.id}
                  onClick={() => onSelect(sub.id)}
                  className={`flex items-center gap-6 p-4 rounded-2xl border-2 transition-all duration-300 text-left relative overflow-hidden group ${
                    selectedDifficulty === sub.id
                      ? 'bg-[#00FFD1]/10 border-[#00FFD1] shadow-[0_0_30px_rgba(0,255,209,0.2)]'
                      : 'bg-[#111E1E]/60 border-white/5 hover:border-white/20'
                  }`}
                >
                  <div className={`p-3 rounded-xl bg-white/5 ${selectedDifficulty === sub.id ? 'text-[#00FFD1]' : 'text-white/40'}`}>
                    <sub.icon className="w-6 h-6" />
                  </div>

                  <div className="flex-1">
                    <h3 className={`font-black italic text-lg tracking-wider transition-colors ${selectedDifficulty === sub.id ? 'text-white' : 'text-white/60'}`}>
                      {sub.name}
                    </h3>
                    <p className="text-[10px] font-mono text-white/40 uppercase tracking-widest mt-0.5">
                      {sub.desc}
                    </p>
                  </div>

                  {selectedDifficulty === sub.id && (
                    <div className="absolute right-4 animate-pulse">
                      <ChevronRight className="w-6 h-6 text-[#00FFD1]" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex gap-4 pt-2">
        <button
          onClick={onCancel}
          className="flex-1 px-8 py-4 border border-white/10 text-white/60 font-black uppercase tracking-widest rounded-xl hover:bg-white/5 transition-all flex items-center justify-center gap-2"
        >
          <X className="w-4 h-4" />
          Abort
        </button>
        <button
          onClick={onConfirm}
          disabled={!activeCategory}
          className={`flex-[2] px-8 py-4 font-black uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-2 ${
            activeCategory
              ? 'bg-[#00FFD1] text-[#081616] hover:shadow-[0_0_30px_rgba(0,255,209,0.4)]'
              : 'bg-white/5 text-white/20 cursor-not-allowed'
          }`}
        >
          {confirmLabel}
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * Difficulty ⇄ (sector, mode) mapping — the ONE table. Do not clone.
 * 10 = eclipse+slayer, 11 = eclipse+lms, 12 = blitz+slayer, 13 = blitz+lms.
 * ------------------------------------------------------------------ */

/** difficulty → { sector, mode }, online sectors only. */
export const CELLS_ONLINE_DIFFICULTY_MAP: Readonly<
  Record<number, { sector: CellsOnlineSectorId; mode: CellsMatchMode }>
> = {
  10: { sector: 'eclipse', mode: 'slayer' },
  11: { sector: 'eclipse', mode: 'lms' },
  12: { sector: 'blitz', mode: 'slayer' },
  13: { sector: 'blitz', mode: 'lms' },
};

/** The difficulty a wager/private picker should start on. */
export const CELLS_DEFAULT_ONLINE_DIFFICULTY = 10;

/** difficulty → { sector, mode }; null for free play / unknown ids. */
export function cellsDifficultyToSectorMode(
  difficulty: number,
): { sector: CellsOnlineSectorId; mode: CellsMatchMode } | null {
  return CELLS_ONLINE_DIFFICULTY_MAP[difficulty] ?? null;
}

/** { sector, mode } → difficulty. */
export function cellsSectorModeToDifficulty(
  sector: CellsOnlineSectorId,
  mode: CellsMatchMode,
): number {
  if (sector === 'eclipse') return mode === 'slayer' ? 10 : 11;
  return mode === 'slayer' ? 12 : 13;
}

/** difficulty → 'eclipse:slayer' | … (privateMatch CATALOG key); null if free/unknown. */
export function cellsDifficultyToCompositeMode(difficulty: number): CellsCompositeMode | null {
  const pair = cellsDifficultyToSectorMode(difficulty);
  return pair ? (`${pair.sector}:${pair.mode}` as CellsCompositeMode) : null;
}

export default CellsDifficultySelector;
