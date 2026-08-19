/**
 * LOBBY LEVEL STRIP — compact level progression, shown in every game lobby
 * ========================================================================
 * A slimmed-down sibling of StatsPanel's LevelStrip: the level label in its
 * band colour, the progress bar across the current level, and the XP still
 * needed — sized to sit under a lobby's title block without competing with
 * the mode tiles.
 *
 * Same data rules as the stats panel:
 *   - query key ['stats','xp'] (shared cache — opening the stats panel and
 *     the lobby can never disagree),
 *   - the level is DERIVED from the XP total via getLevelInfo (one curve,
 *     one answer — never trust a stored level),
 *   - refetch on the onXpAward announcement, so finishing a round and
 *     landing back in the lobby shows the new number without a reload.
 *
 * Renders nothing when signed out or before data lands — a lobby must not
 * grow a skeleton row for a visitor who has no progression to show.
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getLevelInfo, formatXp } from '@neon/types'
import { statsApi } from '../../lib/api'
import { onXpAward } from '../../lib/sessionXp'
import { hasAuthToken } from '../social/usePresence'

export function LobbyLevelStrip() {
  const signedIn = hasAuthToken()

  const query = useQuery({
    queryKey: ['stats', 'xp'],
    queryFn: statsApi.xp,
    enabled: signedIn,
    staleTime: 30_000,
  })

  const refetch = query.refetch
  useEffect(() => onXpAward(() => void refetch()), [refetch])

  const data = query.data
  if (!signedIn || !data) return null

  const info = getLevelInfo(data.xp)

  return (
    <div className="mx-auto w-full max-w-sm space-y-1.5 rounded-xl border border-[#00ffd1]/15 bg-black/30 px-4 py-3 backdrop-blur-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className="text-sm font-black uppercase italic tracking-wider"
          style={{ color: info.color, textShadow: `0 0 12px ${info.color}55` }}
        >
          {info.label}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/35">
          {info.isMaxLevel
            ? 'Max level'
            : `${formatXp(info.xpToNextLevel)} XP to next`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${info.progressPct}%`,
            background: `linear-gradient(90deg, ${info.color}, ${info.color}88)`,
            boxShadow: `0 0 10px ${info.color}66`,
          }}
        />
      </div>
    </div>
  )
}
