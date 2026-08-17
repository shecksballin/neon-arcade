/**
 * NeonViewportGlow.tsx
 *
 * A fixed, full-viewport neon frame. Renders a single overlay div whose
 * inset box-shadow (see `.neon-viewport-glow` in index.css) pools the
 * #00FFD1 glow around the screen edges and fades it toward the centre,
 * giving the whole app a subtle arcade-cabinet halo.
 *
 * It sits above everything (z-index 9999) but is `pointer-events: none`,
 * so clicks pass straight through to the UI below. Purely decorative —
 * hidden from assistive tech via aria-hidden.
 *
 * Pass `active={false}` to unmount it (e.g. to drop the frame inside a
 * fullscreen game view).
 */

export function NeonViewportGlow({ active = true }: { active?: boolean }) {
  if (!active) return null;
  return <div className="neon-viewport-glow" aria-hidden="true" />;
}
