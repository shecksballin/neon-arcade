import { useAnimations, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { SkeletonUtils } from 'three/examples/jsm/Addons.js';
import { KICK_CONTACT, useGame } from '../store';
import { ensureIdle, normalizeCharacter, playIdle, playOnce } from './characters';

const STRIKER_HEIGHT = 1.83;
const STRIKER_KIT = '#ff2f86';
/** the player's own kit — teal, matching how the HUD marks your side */
const PLAYER_KIT = '#2fe6c8';
/** stood off the ball at an angle, the way a taker sets up a run-up */
const STRIKER_POS = new THREE.Vector3(1.15, 0, 13.1);
/** where he plants his standing foot: alongside the ball, not on top of it */
const PLANT_POS = new THREE.Vector3(0.44, 0, 11.42);
/** fraction of the strike clip at which the boot meets the ball */
const CONTACT_FRAC = 0.45;

/**
 * Where the boot has to arrive: the near face of the ball, at the height a
 * penalty is struck. Aiming at the ball's centre would bury the foot inside it.
 */
const CONTACT_OFFSET = new THREE.Vector3(0, -0.02, 0.085);
/**
 * When the assist starts pulling him onto the ball. The kicking leg swings
 * through a wide arc, so measuring the foot early would drag his whole body
 * around with it — this only engages over the last of the run-up, as the leg
 * comes through.
 */
const ASSIST_FROM = 0.62;
/** how far he may be nudged before the run-up stops reading as a run-up */
const MAX_ASSIST = 0.9;

const _pos = new THREE.Vector3();
const _foot = new THREE.Vector3();
const _want = new THREE.Vector3();
const _target = new THREE.Vector3();

function findBone(root: THREE.Object3D, suffix: string): THREE.Object3D | null {
  let hit: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!hit && o.name.toLowerCase().endsWith(suffix.toLowerCase())) hit = o;
  });
  return hit;
}

function smoothstep(t: number) {
  const k = THREE.MathUtils.clamp(t, 0, 1);
  return k * k * (3 - 2 * k);
}

/**
 * How far into the run-up he is, 0 stood still and 1 boot on ball.
 *
 * Your run-up is the stretch of the flight clock before zero; the AI's is the
 * wind-up it starts partway through 'guard'. Reading it off the same clock the
 * ball uses is what keeps the stride and the contact on the same beat.
 */
function runupProgress(g: ReturnType<typeof useGame.getState>): number {
  if (g.turn === 'player') {
    if (g.phase !== 'strike') return 0;
    return THREE.MathUtils.clamp((g.clock.flight + KICK_CONTACT) / KICK_CONTACT, 0, 1);
  }
  if (g.phase === 'strike') return 1;
  if (g.phase !== 'guard' || !g.windup) return 0;
  return THREE.MathUtils.clamp((g.clock.guard - g.clock.windupAt) / KICK_CONTACT, 0, 1);
}

/**
 * The player taking the kick. There is exactly one striker on the pitch at a
 * time: when you are keeping goal it is the AI, and when you are striking it is
 * your own avatar, seen over the shoulder. Both use the same rig, so the only
 * difference is the kit colour and what cues the run-up.
 */
export function Striker() {
  const { scene, animations } = useGLTF('/neon-kickoff/striker.glb');

  const yours = useGame((s) => s.turn === 'player');
  const visible = useGame((s) => s.screen === 'game' && s.phase !== 'over');
  const phase = useGame((s) => s.phase);
  const windup = useGame((s) => s.windup);
  const paused = useGame((s) => s.paused);

  const model = useMemo(() => {
    const clone = SkeletonUtils.clone(scene);
    normalizeCharacter(clone, STRIKER_HEIGHT, STRIKER_KIT);
    return clone;
  }, [scene]);

  // the toe is the part that meets the ball; the ankle sits too far back
  const boot = useMemo(
    () => findBone(model, 'RightToeBase') ?? findBone(model, 'RightFoot'),
    [model]
  );

  // recolour rather than rebuild: cloning the rig again on every change of ends
  // would restart the mixer and drop the pose mid-round
  useEffect(() => {
    const kit = new THREE.Color(yours ? PLAYER_KIT : STRIKER_KIT);
    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        const mat = m as THREE.MeshStandardMaterial;
        if (mat.map) continue;
        mat.color.copy(kit);
        mat.emissive.copy(kit);
      }
    });
  }, [yours, model]);

  const group = useRef<THREE.Group>(null);
  const { actions, mixer } = useAnimations(animations, group);

  useEffect(() => {
    mixer.timeScale = paused ? 0 : 1;
  }, [paused, mixer]);

  // Your kick fires the moment you commit — the run-up is the first stretch of
  // the flight clock. The AI's is cued by its own wind-up during 'guard'.
  const kicking = yours ? phase === 'strike' : windup && (phase === 'guard' || phase === 'strike');

  useEffect(() => {
    if (kicking) {
      // stretch the clip so boot-on-ball lands exactly KICK_CONTACT seconds in,
      // which is the beat the store's flight clock launches the ball on
      const strike = actions.strike;
      const rate = strike ? (strike.getClip().duration * CONTACT_FRAC) / KICK_CONTACT : 1;
      playOnce(strike, actions.idle, rate);
    } else if (phase === 'intro' || phase === 'aim' || phase === 'guard') {
      playIdle(actions.idle, [actions.strike, actions.jog]);
    }
  }, [kicking, phase, actions]);

  // Mixamo's strike clip barely travels, so the stride is driven here: he
  // covers the ground between his mark and the ball over the run-up, easing out
  // so he arrives planted rather than still sprinting.
  /** the correction currently applied on top of the run-up, held after contact */
  const assist = useRef(new THREE.Vector3());
  const planted = useRef(false);

  useFrame(() => {
    const g = useGame.getState();
    const node = group.current;
    if (!node || g.paused) return;

    // same guard as the keeper: never leave the rig on its bind pose
    if (!kicking) ensureIdle(actions);

    const k = runupProgress(g);
    const eased = 1 - (1 - k) * (1 - k);
    _pos.copy(STRIKER_POS).lerp(PLANT_POS, eased);

    if (k <= 0) {
      // back on his mark for a new round
      assist.current.set(0, 0, 0);
      planted.current = false;
      node.position.copy(_pos);
      return;
    }

    // Once the boot is through the ball there is nothing left to aim at, so the
    // correction is held rather than recomputed — otherwise he would follow the
    // ball's flight across the pitch.
    if (!planted.current && boot) {
      _target.copy(g.live.ball).add(CONTACT_OFFSET);

      // Put him on his un-assisted mark first, then read the boot. getWorldPosition
      // refreshes the chain from the root down, so what comes back is where the
      // boot lands this frame with no help — measuring before this would read a
      // frame-old position and the correction would always trail the run-up.
      node.position.copy(_pos);
      boot.getWorldPosition(_foot);

      _want.copy(_target).sub(_foot).clampLength(0, MAX_ASSIST);
      // he plants a foot, he does not levitate onto the ball
      _want.y = THREE.MathUtils.clamp(_want.y, -0.15, 0.15);

      const blend = smoothstep((k - ASSIST_FROM) / (1 - ASSIST_FROM));
      assist.current.copy(_want).multiplyScalar(blend);

      if (k >= 1) planted.current = true;
    }

    node.position.copy(_pos).add(assist.current);
  });

  return (
    <group ref={group} position={STRIKER_POS.toArray()} rotation={[0, Math.PI, 0]} visible={visible}>
      <primitive object={model} />
    </group>
  );
}

useGLTF.preload('/neon-kickoff/striker.glb');
