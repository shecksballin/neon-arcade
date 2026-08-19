/**
 * MATCH PROGRESSION — the per-player "+XP / rank change" wire event
 * =================================================================
 * Until this existed, every game handler wrote its stats rows with
 * `void recordResults(...)` — the XP award was computed inside the stats
 * service and then THROWN AWAY, and the rank settle result only reached
 * clients in game-specific shapes (or, for Connect, not at all). The
 * post-game "you gained +150 XP / RANKED UP" screens need both numbers,
 * per player, reliably.
 *
 * So: ONE event, ONE shape, every game.
 *
 *   io.to(<that player's socket id>).emit('match:progression', {
 *     gameKey,                     // 'chess' | 'connect' | 'volley' | 'quiz'
 *     xp:   XpAward | null,        // amount, before/after, leveledUp, level
 *     rank: PublicRating | null,   // rpBefore/rp/rpChange, rankBefore/rank,
 *   })                             // promoted/demoted — own numbers only
 *
 * PRIVACY: the event goes to each player's PRIVATE socket id — never the
 * game room — because it is that player's own progression. The rank half
 * is the same publicRating() projection the end-of-game payloads already
 * use (wallet/mu/sigma stripped); the XP half exists only for the player
 * it belongs to.
 *
 * ORDERING: fire-and-forget from the game's settle path (`void
 * recordAndEmitProgression(...)`). The game's own end event ships first —
 * play must never wait on a stats INSERT — and the progression event lands
 * a beat later, which is exactly when the client's results screen wants it.
 *
 * The stats write itself is the SAME write recordResults performed (one
 * row per player through recordResultWithXp), so history/XP semantics are
 * unchanged — the award is simply kept instead of discarded.
 */
import type { Server } from 'socket.io'
import {
  recordResultWithXp,
  type RecordResultInput,
} from '../../services/statsService'
import { publicRating, type PublicRating } from '../../services/eloService'
import type { RankedResult } from '../../services/rankService'
import type { XpAward } from '../../services/xpService'

export const MATCH_PROGRESSION_EVENT = 'match:progression'

export interface MatchProgressionPayload {
  gameKey: string
  xp: XpAward | null
  rank: PublicRating | null
}

export interface ProgressionEntry {
  /** Where to deliver — the player's own socket id (a private room). */
  socketId: string
  /** The stats row for this player; written exactly as recordResults did. */
  input: RecordResultInput
  /** This player's own settle result when the match was rated, else null. */
  ranked?: RankedResult | null
}

/**
 * Write each player's stats row (awaiting the XP award instead of
 * discarding it) and deliver their progression event. Never throws — a
 * failed write emits `xp: null` rather than nothing, so a client waiting
 * on the event still hears an answer.
 */
export async function recordAndEmitProgression(
  io: Server,
  gameKey: string,
  entries: ProgressionEntry[]
): Promise<void> {
  await Promise.all(
    entries.map(async ({ socketId, input, ranked }) => {
      let xp: XpAward | null = null
      try {
        const { award } = await recordResultWithXp(input)
        xp = award
      } catch (err) {
        // recordResultWithXp already swallows its own failures; this is a
        // second belt for anything unexpected — progression must not be
        // able to break a game's end path.
        console.error('[progression] stats/xp write failed:', err)
      }
      const payload: MatchProgressionPayload = {
        gameKey,
        xp,
        rank: ranked ? publicRating(ranked) : null,
      }
      io.to(socketId).emit(MATCH_PROGRESSION_EVENT, payload)
    })
  )
}
