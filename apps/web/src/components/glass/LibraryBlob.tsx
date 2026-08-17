/**
 * LibraryBlob.tsx
 *
 * A #00FFEA radial glow blob that follows the user's cursor.
 * Duplicated for the library page so it can be customized independently.
 */

import { Ferrofluid } from './Ferrofluid'

/**
 * MODULE SCOPE ON PURPOSE — do not inline this back into the JSX.
 *
 * `colors` is in Ferrofluid's effect dependency list, and an inline array
 * literal is a new object on every render. LibraryBlob is in every game lobby,
 * and lobbies re-render on ordinary state changes (picking a mode, opening the
 * difficulty drill-down, a matchmaking error arriving) — so an inline literal
 * made Ferrofluid tear down and rebuild its whole OGL renderer, shader program
 * and WebGL context on each of those. A frozen module constant keeps the
 * identity stable, so the effect runs exactly once per mount.
 */
const BLOB_COLORS = ['#89ffea', '#00ffd1', '#00735e']

export function LibraryBlob() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 z-0 overflow-hidden pointer-events-none w-full h-full"
    >
      <Ferrofluid
        colors={BLOB_COLORS}
        speed={0.4}
        scale={1}
        turbulence={1}
        fluidity={0.1}
        rimWidth={0.2}
        sharpness={3}
        shimmer={0.7}
        glow={2.3}
        flowDirection="down"
        opacity={1}
        mouseInteraction={true}
        mouseStrength={0}
        mouseRadius={0.05}
      />
    </div>
  )
}



