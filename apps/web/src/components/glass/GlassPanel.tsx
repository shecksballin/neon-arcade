/**
 * GlassPanel.tsx
 *
 * Layer 3 — the frosted glass UI element.
 *
 * How it achieves the "liquid glass" look:
 *
 *  1. backdrop-filter: blur + saturate + brightness
 *     → blurs and colour-boosts whatever is behind the element.
 *       This is the core frosted-glass effect.
 *
 *  2. background: white at very low opacity with a gradient
 *     → gives the panel a translucent "body".
 *
 *  3. inset box-shadow top (bright) + bottom (dim)
 *     → simulates a specular rim — the bright highlight along the top
 *       edge is what sells the "glass" more than anything else.
 *
 *  4. A ::before pseudo-element via className carries a diagonal
 *     gradient that mimics light refracting across the panel surface.
 *     (Defined in glass.css)
 *
 * Usage:
 *   <GlassPanel>
 *     <h1>bhvr</h1>
 *     <p>your hero copy</p>
 *   </GlassPanel>
 *
 *   <GlassPanel size="sm" radius={12}>
 *     <NavLinks />
 *   </GlassPanel>
 */

import type { CSSProperties, ReactNode } from 'react'
import './glass.css'

interface GlassPanelProps {
  children?: ReactNode
  /** Controls the blur intensity and overall opacity. Default: 'md' */
  variant?: 'subtle' | 'md' | 'heavy'
  /** Border radius in px. Default: 24 */
  radius?: number
  className?: string
  style?: CSSProperties
}

const variantMap = {
  subtle: {
    backdropFilter: 'blur(8px) saturate(140%)',
    background:
      'linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)',
    boxShadow: [
      '0 4px 24px rgba(0,0,0,0.20)',
      'inset 0 1px 0 rgba(255,255,255,0.25)',
      'inset 0 -1px 0 rgba(255,255,255,0.06)',
    ].join(', '),
  },
  md: {
    backdropFilter: 'blur(4px) saturate(220%) contrast(1.08)',
    background: 'rgba(255, 255, 255, 0.03)',
    boxShadow: [
      '0 20px 60px rgba(0, 0, 0, 0.45)',         // deep ground shadow
      'inset 0 1.5px 0 rgba(255,255,255,0.75)',  // sharp top specular — this is gloss
      'inset 0 -1px 0 rgba(255,255,255,0.08)',   // subtle bottom rim
      'inset 1px 0 0 rgba(255,255,255,0.12)',    // left edge catch
      'inset -1px 0 0 rgba(255,255,255,0.06)',   // right edge catch
    ].join(', '),
  },
  heavy: {
    backdropFilter: 'blur(28px) saturate(180%)',
    background:
      'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
    boxShadow: [
      '0 12px 48px rgba(0,0,0,0.35)',
      'inset 0 1px 0 rgba(255,255,255,0.50)',
      'inset 0 -1px 0 rgba(255,255,255,0.12)',
    ].join(', '),
  },
}

export function GlassPanel({
  children,
  variant = 'md',
  radius = 24,
  className = '',
  style,
}: GlassPanelProps) {
  const v = variantMap[variant]

  return (
    <div
      className={`glass-panel ${className}`}
      style={{
        position: 'relative',
        borderRadius: radius,
        backdropFilter: v.backdropFilter,
        WebkitBackdropFilter: v.backdropFilter, // Safari
        background: v.background,
        border: '1px solid rgba(255, 255, 255, 0.22)',
        boxShadow: v.boxShadow,
        /**
         * isolation: isolate creates a new stacking context.
         * This ensures the ::before refraction overlay in glass.css
         * doesn't bleed outside the panel's border-radius.
         */
        isolation: 'isolate',
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </div>
  )
}
