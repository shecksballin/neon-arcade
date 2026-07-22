/**
 * LibraryBlob.tsx
 *
 * A #00FFEA radial glow blob that follows the user's cursor.
 * Duplicated for the library page so it can be customized independently.
 */

import { Ferrofluid } from './Ferrofluid'

export function LibraryBlob() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 z-0 overflow-hidden pointer-events-none w-full h-full"
    >
      <Ferrofluid
        colors={['#89ffea', '#00ffd1', '#00735e']}
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



