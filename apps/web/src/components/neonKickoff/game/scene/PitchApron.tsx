import { useMemo } from 'react';
import * as THREE from 'three';

/**
 * The ground we actually play on.
 *
 * The stadium's own turf is a 121m slab, which behind the striker reads as a
 * grey shelf running off into the dark, so Stadium hides it and this stands in.
 *
 * Fog cannot solve that on its own: fog is a function of distance from the
 * camera, and the ground behind the striker is barely a couple of metres from
 * it — nearer than the goal — so it stays fully lit no matter how tight the fog
 * is pulled. What is needed is a fade by position on the pitch, so the turf is
 * solid through the penalty area and gone by the time it reaches the striker's
 * heels. That is an alpha ramp baked into a texture, keyed to world z.
 */
const WIDTH = 86;
const DEPTH = 74;
const CENTRE_Z = 8;

/** solid up to here, gone by there — measured up the pitch from the goal line */
const FADE_FROM_Z = 14;
const FADE_TO_Z = 23;
/** and the same treatment behind the goal, so the far edge is not a hard line */
const BEHIND_SOLID_Z = -12;
const BEHIND_GONE_Z = -24;
/** across the pitch, so the touchline edges dissolve rather than stop */
const SIDE_SOLID_X = 26;
const SIDE_GONE_X = 40;

function ramp(v: number, solid: number, gone: number) {
  const t = (v - gone) / (solid - gone);
  return THREE.MathUtils.clamp(t, 0, 1);
}

/** smooth, so the dissolve has no visible band in it */
function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

function buildFadeMap(): THREE.Texture {
  const W = 128;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);

  for (let row = 0; row < H; row++) {
    // CanvasTexture flips by default, so the top row of the image is v = 1
    const v = 1 - row / (H - 1);
    const z = CENTRE_Z + DEPTH / 2 - v * DEPTH;
    const alongPitch = smooth(ramp(z, FADE_FROM_Z, FADE_TO_Z));
    const behindGoal = smooth(ramp(z, BEHIND_SOLID_Z, BEHIND_GONE_Z));
    const depthFade = Math.min(alongPitch, behindGoal);

    for (let col = 0; col < W; col++) {
      const u = col / (W - 1);
      const x = Math.abs(u * WIDTH - WIDTH / 2);
      const sideFade = smooth(ramp(x, SIDE_SOLID_X, SIDE_GONE_X));
      const a = Math.round(depthFade * sideFade * 255);
      const i = (row * W + col) * 4;
      // greyscale: three reads an alpha map's green channel
      img.data[i] = a;
      img.data[i + 1] = a;
      img.data[i + 2] = a;
      img.data[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export function PitchApron() {
  const alphaMap = useMemo(buildFadeMap, []);
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#0d2b22',
        roughness: 0.95,
        metalness: 0,
        alphaMap,
        transparent: true,
        // it is the lowest thing in the scene and has nothing to occlude, so it
        // takes no part in the depth buffer and draws before the markings
        depthWrite: false,
      }),
    [alphaMap]
  );

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.005, CENTRE_Z]}
      material={material}
      renderOrder={-1}
      receiveShadow
    >
      <planeGeometry args={[WIDTH, DEPTH]} />
    </mesh>
  );
}
