/**
 * The Pug Shooter map catalog — shared by the lobby's map tile and the
 * full-screen selection page, so the two can never drift.
 *
 * `ffaCap` mirrors the SERVER's per-map FFA lobby sizes
 * (socket/games/lobbyGames.ts: Cold Storage 10 / Neon Suburbs 30) — it is
 * display copy here; the server remains authoritative about capacity.
 */

export type PugShooterMap = 'city' | 'warehouse'

export const MAPS: {
  id: PugShooterMap
  label: string
  detail: string
  ffaCap: number
}[] = [
  { id: 'city', label: 'Neon Suburbs', detail: 'open streets · long sightlines', ffaCap: 30 },
  { id: 'warehouse', label: 'Cold Storage', detail: 'interior · close quarters', ffaCap: 10 },
]

// Slides for the MorphSlider map picker. Module-level so the array identity
// is stable — the slider tears down and rebuilds its WebGL engine whenever
// `items` changes.
export const MAP_SLIDES = MAPS.map((m) => ({
  image: `/pug-map-previews/${m.id}.jpg`,
  caption: m.label,
}))
