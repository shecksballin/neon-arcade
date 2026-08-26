/**
 * GAME REGIONS — the player-selectable server regions (Fly.io region codes).
 *
 * A region is a SEPARATE PLAYER POOL: matches, queues, presence and private
 * rooms live in the memory of that region's machine, so two players must be
 * on the same region to play together or see each other's invites. Accounts,
 * XP, rank and history live in the shared database and follow the player
 * everywhere.
 *
 * The ids are Fly.io region codes on purpose — the server compares the
 * requested id against its own FLY_REGION and answers with a `fly-replay`
 * header when they differ, which makes Fly's proxy re-deliver the request
 * (or websocket upgrade) to a machine in the requested region.
 */
export interface GameRegion {
  /** Fly.io region code — the wire value stored and routed on. */
  id: string
  /** Player-facing name. */
  label: string
  /** Rough coverage hint shown under the label. */
  hint: string
}

export const GAME_REGIONS: readonly GameRegion[] = [
  { id: 'iad', label: 'US East', hint: 'Virginia · Americas East' },
  { id: 'lax', label: 'US West', hint: 'Los Angeles · Americas West' },
  { id: 'lhr', label: 'Europe', hint: 'London · EU / UK' },
  { id: 'sin', label: 'Asia', hint: 'Singapore · SEA / India' },
  { id: 'syd', label: 'Oceania', hint: 'Sydney · AU / NZ' },
] as const

export const DEFAULT_REGION = 'iad'

export function isGameRegion(value: unknown): value is string {
  return typeof value === 'string' && GAME_REGIONS.some((r) => r.id === value)
}
