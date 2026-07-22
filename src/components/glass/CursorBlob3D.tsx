/**
 * CursorBlob3D.tsx
 *
 * Drop-in replacement for CursorGlow.tsx.
 * Swap the import in LandingPage.tsx — nothing else changes.
 *
 * Before:
 *   import { CursorGlow }    from '../components/glass/CursorGlow'
 *   <CursorGlow />
 *
 * After:
 *   import { CursorBlob3D } from '../components/glass/CursorBlob3D'
 *   <CursorBlob3D />
 *
 * The Canvas:
 *   - gl={{ alpha: true }}     → transparent background (shows layers below)
 *   - flat                     → disables tone mapping (keeps emissive crisp)
 *   - pointerEvents: 'none'    → mouse events pass through to the page
 *   - position: absolute       → fills the hero section, z-index 1
 *
 * Performance notes:
 *   - The Canvas is isolated from React's render cycle; R3F drives its own
 *     rAF loop internally via useFrame.
 *   - frameloop="demand" is intentionally NOT used here because the blob
 *     animates continuously. Use frameloop="demand" only for static scenes.
 */

import { Canvas } from '@react-three/fiber'
import { BlobScene } from './BlobScene'

export function CursorBlob3D() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1,
        pointerEvents: 'none',
      }}
    >
      <Canvas
        /**
         * alpha: true → the WebGL canvas background is transparent.
         * Without this the Canvas renders a solid black background,
         * covering LiquidBackground beneath it.
         */
        gl={{ alpha: true, antialias: true }}
        /**
         * flat disables R3F's default ACESFilmic tone mapping.
         * Tone mapping desaturates bright emissive colours — disabling it
         * keeps the #00FFD1 looking vivid rather than washed out.
         */
        flat
        /**
         * Camera positioned 5 units back on Z.
         * fov 50 gives a natural perspective without too much distortion.
         * Adjust camera.position.z if the blob feels too large or small.
         */
        camera={{ position: [0, 0, 5], fov: 50 }}
        style={{ width: '100%', height: '100%' }}
      >
        <BlobScene />
      </Canvas>
    </div>
  )
}
