// src/components/common/LobbyModeTiles.tsx
//
// THE PRACTICE / ONLINE / WAGER TILE ROW that closes every game lobby.
//
// This row used to be copy-pasted (identically) into Chess, Connect, Trivia and
// Volley, and was simply missing from Clumsy, Golf and Pug Shooter. It is the
// arcade's shared lobby footer, so it lives here ONCE and every lobby renders
// the same three tiles in the same place: as the LAST element of the lobby's
// content column.
//
// Two modes, one component:
//   • DECORATIVE (default) — no `onSelect`, tiles are `cursor-default` and
//     purely a signature of the lobby design. This is what Chess/Connect/
//     Trivia and the newly-covered lobbies use.
//   • SELECTABLE — pass `selectedId` + `onSelect` and the tiles become the
//     picker they already are in Volley (where they choose the match ruleset),
//     highlighting the active one exactly as before.
import { ParticleCard } from '../glass/MagicGameTile';

/** One tile: a material-symbols glyph over a tiny mono label. */
export interface LobbyModeTile {
  /** Value handed to `onSelect`; ignored in decorative mode. */
  id: string;
  /** material-symbols-outlined ligature name. */
  icon: string;
  label: string;
}

/**
 * The canonical trio. Lobbies that need different wording (Chess calls the
 * third one RANKED, because online chess moves ELO and stakes nothing) pass
 * their own `tiles` instead of redefining the markup.
 */
export const DEFAULT_LOBBY_MODE_TILES: LobbyModeTile[] = [
  { id: 'practice', icon: 'videogame_asset', label: 'Practice' },
  { id: 'online', icon: 'smart_toy', label: 'Online' },
  { id: 'wager', icon: 'trending_up', label: 'Wager' },
];

interface LobbyModeTilesProps {
  tiles?: LobbyModeTile[];
  /** Highlighted tile. Only meaningful together with `onSelect`. */
  selectedId?: string;
  /** Omit to render the decorative (non-interactive) row. */
  onSelect?: (id: string) => void;
  /** Extra classes on the grid — use it to tune the gap above the row. */
  className?: string;
}

const LobbyModeTiles = ({
  tiles = DEFAULT_LOBBY_MODE_TILES,
  selectedId,
  onSelect,
  className = 'mt-12',
}: LobbyModeTilesProps) => (
  <div className={`grid grid-cols-1 md:grid-cols-3 gap-4 ${className}`}>
    {tiles.map((tile) => {
      const selected = onSelect ? selectedId === tile.id : false;
      return (
        <ParticleCard
          key={tile.id}
          onClick={onSelect ? () => onSelect(tile.id) : undefined}
          className={`magic-bento-card magic-bento-card--border-glow backdrop-blur-md p-5 rounded-xl border flex flex-col items-center gap-2 transition-all ${
            onSelect ? 'cursor-pointer' : 'cursor-default'
          } ${
            selected
              ? 'border-[#00FFD1] shadow-[0_0_15px_rgba(0,255,209,0.5)]'
              : 'border-[#00FFD1]/40'
          }`}
        >
          <div className="material-symbols-outlined text-[#00FFD1] text-2xl">
            {tile.icon}
          </div>
          <p className="text-[10px] font-mono tracking-widest uppercase text-[#B1C5FF]/70">
            {tile.label}
          </p>
        </ParticleCard>
      );
    })}
  </div>
);

export default LobbyModeTiles;
