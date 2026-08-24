import { useMemo } from 'react';
import * as THREE from 'three';
import { backSurfaceZ, NET_DEPTH_BOTTOM, NET_DEPTH_TOP, VISUAL_STEP } from '../net';
import { GOAL_H, GOAL_W } from '../types';

/**
 * The goal itself: glowing posts and crossbar, plus the netting that never gets
 * hit from the penalty spot — the roof and the two side panels.
 *
 * The back curtain is the one panel a shot can reach, so it lives in GoalNet
 * where it is simulated. Everything here is static geometry, drawn at the same
 * mesh spacing and in the same colour so the two read as one net.
 */
function buildStaticNet(): THREE.BufferGeometry {
  const pts: number[] = [];
  const hw = GOAL_W / 2;
  const push = (a: THREE.Vector3, b: THREE.Vector3) => pts.push(a.x, a.y, a.z, b.x, b.y, b.z);

  // roof: crossbar back to the top of the curtain
  for (let x = -hw; x <= hw + 1e-4; x += VISUAL_STEP) {
    push(new THREE.Vector3(x, GOAL_H, 0), new THREE.Vector3(x, GOAL_H, -NET_DEPTH_TOP));
  }
  for (let z = 0; z >= -NET_DEPTH_TOP - 1e-4; z -= VISUAL_STEP) {
    push(new THREE.Vector3(-hw, GOAL_H, z), new THREE.Vector3(hw, GOAL_H, z));
  }

  // side panels
  for (const sx of [-hw, hw]) {
    for (let y = 0; y <= GOAL_H + 1e-4; y += VISUAL_STEP) {
      push(new THREE.Vector3(sx, y, 0), new THREE.Vector3(sx, y, backSurfaceZ(y)));
    }
    for (let z = 0; z >= -NET_DEPTH_BOTTOM - 1e-4; z -= VISUAL_STEP) {
      // the top edge is flat under the roof, then slopes down the back curtain
      const k = (-z - NET_DEPTH_TOP) / (NET_DEPTH_BOTTOM - NET_DEPTH_TOP);
      const topY = z >= -NET_DEPTH_TOP ? GOAL_H : GOAL_H * (1 - Math.min(1, k));
      push(new THREE.Vector3(sx, 0, z), new THREE.Vector3(sx, topY, z));
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

export function GoalFrame() {
  const net = useMemo(buildStaticNet, []);
  const postMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#dffdfa',
        emissive: new THREE.Color('#5ffbe2'),
        emissiveIntensity: 1.5,
        roughness: 0.35,
      }),
    []
  );
  const hw = GOAL_W / 2;
  const R = 0.062;

  return (
    <group>
      <mesh position={[-hw, GOAL_H / 2, 0]} material={postMat} castShadow>
        <cylinderGeometry args={[R, R, GOAL_H + R, 16]} />
      </mesh>
      <mesh position={[hw, GOAL_H / 2, 0]} material={postMat} castShadow>
        <cylinderGeometry args={[R, R, GOAL_H + R, 16]} />
      </mesh>
      <mesh position={[0, GOAL_H, 0]} rotation={[0, 0, Math.PI / 2]} material={postMat} castShadow>
        <cylinderGeometry args={[R, R, GOAL_W + R * 2, 16]} />
      </mesh>
      <lineSegments geometry={net}>
        <lineBasicMaterial color="#8ffff0" transparent opacity={0.32} />
      </lineSegments>
      {/* soft glow lights hugging the posts */}
      <pointLight position={[-hw, GOAL_H, 0.4]} color="#00ffd1" intensity={14} distance={9} />
      <pointLight position={[hw, GOAL_H, 0.4]} color="#00ffd1" intensity={14} distance={9} />
    </group>
  );
}
