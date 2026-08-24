/**
 * BlobScene.tsx
 *
 * Retrowave sun — a sphere with:
 *   - Solid teal upper hemisphere
 *   - Horizontal scanlines cutting through the lower hemisphere
 *   - Perspective compression on the lines (wider gap at top → denser at bottom)
 *   - Bloom glow halo via postprocessing
 *   - Cursor follow + lerp from your original code (untouched)
 *
 * The scanline effect is a custom GLSL shader — no texture needed.
 * It runs entirely on the GPU so there's zero JS overhead per frame.
 */

import { useRef, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";

/* ── Config ─────────────────────────────────────────────────────────────── */

// Deep-teal sun (was #00FFEA cyan) — matches the arcade's #15bea0 accent.
const GLOW_COLOR = "#15bea0";
const LERP_FACTOR = 0.06;
const RADIUS = 1.1; // sphere radius — increase to make it bigger

/* ── Cursor state ───────────────────────────────────────────────────────── */

const ndcVec = new THREE.Vector3();
const targetPos = new THREE.Vector3();
const mouse = { x: 0, y: 0 };

if (typeof window !== "undefined") {
  window.addEventListener(
    "mousemove",
    (e) => {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    },
    { passive: true },
  );
}

/* ── GLSL shaders ───────────────────────────────────────────────────────── */

/**
 * Vertex shader — standard pass-through.
 * Passes UV and local position to the fragment shader.
 */
const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vPosition;

  void main() {
    vUv      = uv;
    vPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Fragment shader — the retrowave scanline logic.
 *
 * HOW THE SCANLINES WORK:
 *   vUv.y runs 0 (bottom pole) → 1 (top pole) across the sphere surface.
 *
 *   For the upper half (vUv.y > STRIPE_THRESHOLD) → solid colour.
 *
 *   For the lower half → we compress the UV range into a 0–1 value (t),
 *   then apply a power curve (pow(t, PERSPECTIVE)) which bunches lines
 *   together toward the bottom — the classic perspective grid look.
 *   fract() then tiles that curved value to produce repeating bands.
 *   Bands below STRIPE_GAP are discarded (transparent gap).
 *
 * TUNE:
 *   STRIPE_THRESHOLD  — how far down the solid cap extends (0.5 = equator)
 *   STRIPE_COUNT      — number of stripe pairs visible
 *   STRIPE_GAP        — thickness of each dark gap (0–1, relative to band)
 *   PERSPECTIVE       — power curve exponent; higher = more bunching at bottom
 */
const fragmentShader = /* glsl */ `
  uniform vec3  uColor;
  uniform float uOpacity;
  uniform float uReflection; // kept at 0.0 — the reflection copy was removed,
                             // and 0.0 makes the fade branch below a no-op
  uniform float uRadius;

  varying vec2  vUv;
  varying vec3  vPosition;

  void main() {
    float y = (vPosition.y + uRadius) / (2.0 * uRadius); // 0.0 = bottom, 1.0 = top

    /* ── Reflection fade: reflection copy fades toward its top edge ── */
    float reflectionFade = uReflection > 0.5
      ? (1.0 - smoothstep(0.3, 1.0, y)) * 0.4
      : 1.0;

    /* ── Scanline zone: below this Y value ────────────────────────── */
    float STRIPE_THRESHOLD = 0.52;
    float STRIPE_COUNT     = 8.0;
    float STRIPE_GAP       = 0.75;  // much larger fraction for visible gaps
    float PERSPECTIVE      = 1.5;   // power curve

    float alpha = uOpacity * reflectionFade;

    if (y < STRIPE_THRESHOLD) {
      /* Normalise: 0.0 at bottom pole → 1.0 at stripe threshold */
      float t = y / STRIPE_THRESHOLD;

      /* Apply perspective curve — compresses stripes toward bottom */
      float curved = pow(t, PERSPECTIVE);

      /* Tile into repeating bands, offset so the bottom starts as a drawn semi-circle (arc) */
      float band = fract(curved * STRIPE_COUNT + STRIPE_GAP);

      /* Discard the gap portion of each band */
      if (band < STRIPE_GAP) {
        discard;
      }
    }

    gl_FragColor = vec4(uColor, alpha);
  }
`;

/* ── Sun mesh ───────────────────────────────────────────────────────────── */

function RetrowaveSun() {
  const sunRef = useRef<THREE.Mesh>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const { camera } = useThree();

  /* Build uniforms once — update them in useFrame without recreating */
  const sunUniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Color(GLOW_COLOR) },
      uOpacity: { value: 0.97 },
      uReflection: { value: 0.0 },
      uRadius: { value: RADIUS },
    }),
    [],
  );

  useFrame(() => {
    if (!sunRef.current || !lightRef.current) return;

    /* ── Cursor tracking (your original logic, untouched) ────────────── */
    ndcVec.set(mouse.x, mouse.y, 0.5);
    ndcVec.unproject(camera);

    targetPos.set(ndcVec.x * 3.2, 0, 0);

    sunRef.current.position.lerp(targetPos, LERP_FACTOR);
    lightRef.current.position.copy(sunRef.current.position);

  });

  const sharedGeom = useMemo(() => new THREE.CircleGeometry(RADIUS, 64), []);

  return (
    <>
      <ambientLight intensity={0.1} />
      <pointLight
        ref={lightRef}
        color={GLOW_COLOR}
        intensity={6}
        distance={10}
        decay={2}
      />

      {/* ── Main sun ───────────────────────────────────────────────────── */}
      <mesh ref={sunRef} geometry={sharedGeom}>
        <shaderMaterial
          vertexShader={vertexShader}
          fragmentShader={fragmentShader}
          uniforms={sunUniforms}
          transparent
          side={THREE.FrontSide}
        />
      </mesh>
    </>
  );
}

/* ── Post-processing ─────────────────────────────────────────────────────── */

function PostFX() {
  return (
    <EffectComposer>
      {/*
       * Bloom props tuned for the retrowave look:
       *   luminanceThreshold 0.1  → even mid-bright surfaces glow
       *   intensity 2.2           → hot halo, matches the image reference
       *   mipmapBlur              → smoother wide glow at low perf cost
       */}
      <Bloom
        luminanceThreshold={0.5}
        luminanceSmoothing={0.4}
        intensity={0.8}
        radius={0.4}
      />
    </EffectComposer>
  );
}

/* ── Export ──────────────────────────────────────────────────────────────── */

export function BlobScene() {
  return (
    <>
      <RetrowaveSun />
      <PostFX />
    </>
  );
}
