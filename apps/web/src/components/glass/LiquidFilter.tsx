/**
 * LiquidFilter.tsx
 *
 * Renders a hidden SVG that defines the #liquid-glass filter.
 * Mount this ONCE at the top of App.tsx — it must be in the DOM
 * before any element references filter="url(#liquid-glass)".
 *
 * The filter works in two stages:
 *  1. feTurbulence  → generates animated organic noise
 *  2. feDisplacementMap → uses R channel (X warp) and G channel (Y warp)
 *     to physically displace pixels in the element it's applied to.
 *
 * Tune:
 *  - baseFrequency  → lower = slower/larger waves, higher = tighter ripple
 *  - scale          → displacement intensity (pixels). 18–30 is a good range.
 *  - numOctaves     → detail layers. 3 is smooth, 5 is more turbulent.
 *  - dur (animate)  → breathing speed of the animation.
 */
export function LiquidFilter() {
  return (
    <svg
      aria-hidden="true"
      style={{
        position: 'absolute',
        width: 0,
        height: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <defs>
        <filter
          id="liquid-glass"
          x="-10%"
          y="-10%"
          width="120%"
          height="120%"
          colorInterpolationFilters="sRGB"
        >
          {/* Step 1 — generate animated fractal noise */}
          {/* STATIC noise, deliberately. The old SMIL <animate> morphed
              baseFrequency forever, which forced the browser to regenerate
              fractal noise + displacement + blur over every filtered element
              on EVERY frame, for the lifetime of the page — one of the two
              biggest continuous costs on the landing page, for a morph that
              was barely perceptible on a nav pill. The liquid-glass
              distortion itself (what people actually see) is unchanged. */}
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.012 0.015"
            numOctaves={3}
            seed={5}
            result="noise"
          />

          {/* Step 2 — displace source pixels using the noise map
              xChannelSelector="R" → red channel drives horizontal warp
              yChannelSelector="G" → green channel drives vertical warp
              scale controls warp intensity in pixels               */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale={22}
            xChannelSelector="R"
            yChannelSelector="G"
            result="displaced"
          />

          {/* Step 3 — subtle blur softens the displacement edge */}
          <feGaussianBlur in="displaced" stdDeviation={1.5} result="blurred" />

          {/* Step 4 — clip result to original shape bounds (critical!)
              Without this the displacement bleeds outside the element. */}
          <feComposite in="blurred" in2="SourceGraphic" operator="in" />
        </filter>
      </defs>
    </svg>
  )
}
