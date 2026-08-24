import { useAnimations, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { SkeletonUtils } from 'three/examples/jsm/Addons.js';
import { useGame } from '../store';
import { ensureIdle, normalizeCharacter, playIdle, playOnce } from './characters';

const GOALIE_HEIGHT = 1.92;
/** keepers wear their own colour — a lighter magenta than the outfield kit */
const KEEPER_KIT = '#ff5ea8';
const BASE = new THREE.Vector3(0, 0, 0.42);

/** fraction into a dive clip at which the gloves are at full stretch */
const REACH_FRAC = 0.42;
/** a dive can be hurried or held, but not turned into a cartoon */
const RATE_RANGE: [number, number] = [0.85, 2.3];
/** how far he may be helped toward the ball before it stops reading as a dive */
const MAX_REACH = 1.5;

const _hand = new THREE.Vector3();
const _rest = new THREE.Vector3();
const _want = new THREE.Vector3();

function findBone(root: THREE.Object3D, suffix: string): THREE.Object3D | null {
  let hit: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!hit && o.name.toLowerCase().endsWith(suffix.toLowerCase())) hit = o;
  });
  return hit;
}

/**
 * The AI keeper, on screen while the player takes the kick.
 *
 * Two things have to line up for a save to look like one. The dive is cued from
 * useFrame on the frame the boot connects — not from a selector, because the
 * frame clock is mutated outside the store's setter and never notifies a
 * subscriber — and the clip is stretched so his gloves reach full stretch exactly
 * as the ball reaches the line, however hard the shot was hit.
 *
 * The clip alone still falls short of a well-placed corner, so on a save he is
 * walked the rest of the way: each frame we measure where his nearest glove
 * actually is and slide his whole body by the shortfall, ramped in over the
 * dive so he arrives on the ball rather than snapping onto it. Beat him and no
 * help is given — he stretches for the corner he picked and misses.
 */
export function Goalie() {
  const { scene, animations } = useGLTF('/neon-kickoff/goalie.glb');
  const model = useMemo(() => {
    const clone = SkeletonUtils.clone(scene);
    normalizeCharacter(clone, GOALIE_HEIGHT, KEEPER_KIT);
    return clone;
  }, [scene]);

  const hands = useMemo(
    () => ({
      left: findBone(model, 'LeftHand'),
      right: findBone(model, 'RightHand'),
    }),
    [model]
  );

  const group = useRef<THREE.Group>(null);
  const { actions, mixer } = useAnimations(animations, group);

  const visible = useGame((s) => s.screen === 'game' && s.turn === 'player' && s.phase !== 'over');
  const paused = useGame((s) => s.paused);

  useEffect(() => {
    mixer.timeScale = paused ? 0 : 1;
  }, [paused, mixer]);

  const stance = useRef<'set' | 'committed'>('set');
  const offset = useRef(new THREE.Vector3());
  /** the ball is past — stop reaching and let him land */
  const landing = useRef(false);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const g = useGame.getState();
    const node = group.current;
    if (!node || g.paused) return;

    const kick = g.kick;
    const struck = g.phase === 'strike' && g.clock.booted && kick?.kicker === 'player';

    // whatever else is going on, he must never be left standing in a T-pose
    if (stance.current === 'set') ensureIdle(actions);

    if (struck && stance.current === 'set') {
      stance.current = 'committed';
      landing.current = false;
      // striker-space 'right' (+x) arrives at the keeper's left hand
      const name =
        kick!.guess === 'right' ? 'dive-left' : kick!.guess === 'left' ? 'dive-right' : 'catch';
      const action = actions[name];
      // stretch the dive so full stretch lands on the ball's arrival, not a
      // beat after it — a 0.55s green strike needs a far quicker dive than a
      // scuffed one, and the clip is the same length either way
      const rate = action
        ? THREE.MathUtils.clamp(
            (action.getClip().duration * REACH_FRAC) / Math.max(g.clock.flightCross, 0.05),
            RATE_RANGE[0],
            RATE_RANGE[1]
          )
        : 1;
      playOnce(action, actions.idle, rate);
    }

    if (!struck && g.phase !== 'strike' && g.phase !== 'result' && stance.current === 'committed') {
      stance.current = 'set';
      landing.current = false;
      offset.current.set(0, 0, 0);
      node.position.copy(BASE);
      playIdle(actions.idle, [actions.catch, actions['dive-left'], actions['dive-right']]);
      return;
    }

    // Once the ball is past he stops reaching — but the lift that carried his
    // gloves up to it has to be given back, or he hangs in mid-air holding the
    // top of his dive. Ease it out and he comes down onto the turf where the
    // clip's final pose already has him lying.
    if (landing.current) {
      offset.current.y = THREE.MathUtils.damp(offset.current.y, 0, 7, dt);
      node.position.copy(BASE).add(offset.current);
      return;
    }

    // ---- reach assist, only when this one is going to be saved
    if (stance.current !== 'committed' || kick?.outcome !== 'saved') return;

    const k = THREE.MathUtils.clamp(g.clock.flight / Math.max(g.clock.flightCross, 0.05), 0, 1);

    const ball = g.live.ball;
    const bone =
      hands.left && hands.right
        ? hands.left.getWorldPosition(_hand).distanceTo(ball) <
          hands.right.getWorldPosition(_want).distanceTo(ball)
          ? hands.left
          : hands.right
        : (hands.left ?? hands.right);
    if (!bone) return;

    // where the glove would be with no help at all
    bone.getWorldPosition(_hand);
    _rest.copy(_hand).sub(offset.current);

    _want.copy(ball).sub(_rest).clampLength(0, MAX_REACH);
    // his body rises into a dive, but he is not allowed to take off
    _want.y = THREE.MathUtils.clamp(_want.y, -0.25, 0.5);

    offset.current.copy(_want).multiplyScalar(k * k * (3 - 2 * k)); // smoothstep
    node.position.copy(BASE).add(offset.current);

    // once the ball is past, stop chasing it — he has made the save or not
    if (k >= 1) landing.current = true;
  });

  return (
    <group ref={group} position={BASE.toArray()} visible={visible}>
      <primitive object={model} />
    </group>
  );
}

useGLTF.preload('/neon-kickoff/goalie.glb');
