/**
 * REGION SELECT — the shared picker for the player's game region.
 * Used on the account-setup identity step and in Profile Settings.
 *
 * A region is a separate PLAYER POOL (matches, queues and invites live on
 * that region's server), so the hint under the pills says the part that
 * matters socially: play where your friends play.
 */
import { GAME_REGIONS } from '@neon/types';

export function RegionSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (region: string) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {GAME_REGIONS.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onChange(r.id)}
            className={`rounded-xl border px-3 py-2.5 text-left transition-all cursor-pointer ${
              value === r.id
                ? 'border-[#00FFD1] bg-[#00FFD1]/10 shadow-[0_0_15px_rgba(0,255,209,0.3)]'
                : 'border-white/10 bg-white/5 hover:border-[#00FFD1]/40'
            }`}
          >
            <span
              className={`block text-[12px] font-black uppercase tracking-wider ${
                value === r.id ? 'text-[#00FFD1]' : 'text-white/85'
              }`}
            >
              {r.label}
            </span>
            <span className="mt-0.5 block text-[9px] font-mono uppercase tracking-widest text-white/35">
              {r.hint}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-[9px] font-mono uppercase tracking-[0.2em] text-white/30">
        Each region is its own player pool — pick where your friends play
      </p>
    </div>
  );
}

export default RegionSelect;
