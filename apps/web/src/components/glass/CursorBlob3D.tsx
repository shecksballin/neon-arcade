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
        /**
         * WHY eventSource IS PINNED TO document.body.
         *
         * R3F subscribes its event system inside `onCreated`, which runs
         * asynchronously after the renderer exists, and by default it
         * subscribes to `canvas.parentElement`. Leaving the landing page
         * while that is still in flight — clicking PLAY NOW, say — unmounts
         * this Canvas first, so `parentElement` is null by the time the
         * callback fires and R3F throws:
         *
         *   TypeError: Cannot read properties of null (reading 'addEventListener')
         *       at Object.connect → onCreated
         *
         * The throw happens in an async callback, so the SafeErrorBoundary
         * around this component cannot catch it. R3F's setup is left
         * half-finished, its teardown never runs, and the WebGL context
         * leaks — a few transitions later the browser force-reclaims one
         * ("THREE.WebGLRenderer: Context Lost") and the whole page freezes.
         * That freeze is what made the account screen look permanently
         * stuck: the spinner stops repainting while the sign-in it is
         * waiting on is still running perfectly well underneath.
         *
         * document.body is the one element guaranteed to exist for the
         * lifetime of the page — unlike a ref, which React nulls on
         * unmount, reintroducing the exact crash. It costs nothing here:
         * the scene registers no pointer handlers, so R3F's interaction
         * list is empty and a pointer move raycasts against nothing.
         */
        eventSource={typeof document !== 'undefined' ? document.body : undefined}
        style={{ width: '100%', height: '100%' }}
      >
        <BlobScene />
      </Canvas>
    </div>
  )
}
