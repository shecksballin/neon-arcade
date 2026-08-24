import { REGULATION, nextKicker, taken, type ShootoutState } from '../shootout';
import type { Side } from '../types';

/**
 * The broadcast-style shootout tracker: one pip per kick — teal = scored,
 * pink = missed, pulsing outline = the kick being taken right now.
 */
export function ScorePips({
  shootout,
  side,
  active,
  big = false,
}: {
  shootout: ShootoutState;
  side: Side;
  active: boolean;
  big?: boolean;
}) {
  const kicks = shootout.kicks[side];
  const slots = Math.max(REGULATION, taken(shootout, 'player'), taken(shootout, 'ai'));
  const current = active && !shootout.winner && nextKicker(shootout) === side ? kicks.length : -1;
  const sz = big ? 'w-5 h-5' : 'w-3.5 h-3.5';

  return (
    <div className="flex gap-1.5">
      {Array.from({ length: slots }, (_, i) => {
        const r = kicks[i];
        let cls = 'border border-white/15 bg-white/5';
        if (r === true) cls = 'bg-[#00FFD1] border border-[#00FFD1] shadow-[0_0_8px_rgba(0,255,209,0.8)]';
        else if (r === false) cls = 'bg-[#FF0080]/80 border border-[#FF0080] shadow-[0_0_8px_rgba(255,0,128,0.6)]';
        else if (i === current) cls = 'border-2 border-[#00FFD1] bg-[#00FFD1]/10 animate-pulse';
        return <span key={i} className={`${sz} rounded-full ${cls}`} />;
      })}
    </div>
  );
}
