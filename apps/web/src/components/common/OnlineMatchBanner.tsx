import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import type { OnlineMatch } from './onlineLobbyMatch';

/**
 * Roster strip for the three iframe games (Golf / Clumsy / Pug Shooter) after a
 * real online match is found.
 *
 * It exists for two reasons:
 *  1. the player should see WHO they were matched with, since the queue is the
 *     part that is genuinely online;
 *  2. it says out loud that the round itself still runs locally — those games'
 *     simulations are not networked yet, and a silent boot would read as a lie.
 *
 * Auto-hides after a few seconds and never eats pointer events, so it can't get
 * in the way of a pointer-locked game.
 */
export interface OnlineMatchBannerProps {
  match: OnlineMatch;
  /** Milliseconds before it fades out (0 keeps it up). */
  duration?: number;
  /** 'top' (default) or 'bottom' — a PERSISTENT banner must sit where the
   *  game's own HUD isn't (golf's round timer and clumsy's players-left
   *  panel both live top-centre). */
  placement?: 'top' | 'bottom';
}

export function OnlineMatchBanner({
  match,
  duration = 9000,
  placement = 'top',
}: OnlineMatchBannerProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!duration) return;
    const id = window.setTimeout(() => setVisible(false), duration);
    return () => window.clearTimeout(id);
  }, [duration, match.matchId]);

  if (!visible) return null;

  const opponents = match.players.filter((p) => !p.you).map((p) => p.name);

  return (
    <div
      className={`absolute ${placement === 'bottom' ? 'bottom-6' : 'top-6'} left-1/2 -translate-x-1/2 z-40 pointer-events-none max-w-[90vw]`}
    >
      <div className="px-5 py-3 rounded-2xl border border-[#00FFD1]/40 bg-[#041010]/90 backdrop-blur-md shadow-[0_0_30px_rgba(0,255,209,0.18)] text-center">
        <p className="flex items-center justify-center gap-2 text-[10px] font-mono uppercase tracking-[0.3em] text-[#00FFD1]">
          <Users className="w-3.5 h-3.5" />
          Online match
        </p>
        <p className="mt-1.5 text-white font-black uppercase italic tracking-tighter text-lg leading-none">
          {opponents.length > 0 ? `You vs ${opponents.join(' · ')}` : 'You'}
        </p>
        {/* Honesty line — the queue and the verdict are real; each player's
            round still runs locally and the scores get compared. */}
        <p className="mt-2 text-[9px] font-mono uppercase tracking-[0.22em] text-[#B1C5FF]/45">
          Matched live · everyone plays their own round · highest score wins
        </p>
      </div>
    </div>
  );
}

export default OnlineMatchBanner;
