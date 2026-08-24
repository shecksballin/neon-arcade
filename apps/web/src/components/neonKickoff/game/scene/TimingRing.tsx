import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RING_MIN_R, ringRadius, ringZone, ZONE_COLOR } from '../ring';
import { useGame } from '../store';
import { SPOT } from '../types';

/** radial-gradient sprite texture for the soft glow puddle */
function makeGlowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function TimingRing() {
  const visible = useGame((s) => s.phase === 'aim');
  const ringRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const ringMat = useMemo(
    () => new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    []
  );
  const glowTex = useMemo(makeGlowTexture, []);
  const glowMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: glowTex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [glowTex]
  );
  const color = useMemo(() => new THREE.Color(), []);

  useFrame(() => {
    const g = useGame.getState();
    if (g.phase !== 'aim' || !ringRef.current || !glowRef.current) return;
    const t = g.clock.cycle;
    const r = ringRadius(t);
    const zone = ringZone(t);
    color.set(ZONE_COLOR[zone]);

    ringRef.current.scale.setScalar(r);
    // the glow "pulsates": brightens as the ring closes on the sweet spot,
    // with a fast flicker layered on top that speeds up as the wait drags on
    const flicker = 0.12 * Math.sin(g.clock.aim * (8 + g.clock.aim * 1.5));
    const heat = 0.55 + 0.45 * t + flicker;

    const rm = ringMat;
    rm.color.copy(color).multiplyScalar(2.4); // >1 so bloom catches it
    rm.opacity = Math.min(1, 0.65 + 0.35 * t);

    glowRef.current.scale.setScalar(r * 3.4);
    glowMat.color.copy(color).multiplyScalar(heat);
    glowMat.opacity = Math.min(1, heat);
  });

  return (
    <group position={[SPOT.x, 0.015, SPOT.z]} visible={visible}>
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} material={ringMat}>
        <ringGeometry args={[0.86, 1, 64]} />
      </mesh>
      <mesh ref={glowRef} rotation={[-Math.PI / 2, 0, 0]} material={glowMat} position={[0, -0.004, 0]}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      {/* faint marker of the sweet-spot radius so the target reads at a glance */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} scale={RING_MIN_R}>
        <ringGeometry args={[0.9, 1, 48]} />
        <meshBasicMaterial color="#2bff8f" transparent opacity={0.35} depthWrite={false} />
      </mesh>
    </group>
  );
}
