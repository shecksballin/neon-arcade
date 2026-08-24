import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { playSample, preloadSample, SAMPLE_LATENCY } from '../audio';
import { useGame } from '../store';

/**
 * The goal burst — a cel-animation explosion in the arcade's teal, thrown out
 * the instant the ball buries itself in the netting.
 *
 * Everything is MeshBasicMaterial, so nothing is lit and every surface is one
 * flat colour: that is what makes it read as toon rather than as a fireball.
 * The rest of the look comes from quantising time into frames — the opacity and
 * the shard scale step through a handful of discrete values instead of easing
 * smoothly, the way hand-drawn animation pops rather than dissolves.
 */
const TEAL = '#00FFD1';
const CORE = '#d9fffa';

/** seconds the whole burst lives */
const LIFE = 0.72;
/** how many discrete frames it is drawn on — low is what sells the toon look */
const FRAMES = 6;
const SHARDS = 12;

/**
 * When it goes off, measured from the ball crossing the line.
 *
 * Timed off the crossing rather than off the end of the follow-through: the goal
 * is scored the moment the ball is over the line, and that is the beat the burst
 * and its bang want to land on. Waiting for the ball to finish settling in the
 * netting reads as a late reaction.
 */
const TRIGGER_AFTER_CROSS = 0.12;

const EXPLOSION = '/neon-kickoff/goal-explosion.mp3';

function easeOut(k: number) {
  return 1 - (1 - k) * (1 - k) * (1 - k);
}

export function GoalBurst() {
  const group = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const shell = useRef<THREE.Mesh>(null);
  const core = useRef<THREE.Mesh>(null);
  const shards = useRef<THREE.Group>(null);

  const life = useRef({ active: false, t: 0, fired: false, banged: false });

  // decode it up front so the first goal of a match bangs on time
  useEffect(() => {
    preloadSample(EXPLOSION);
  }, []);

  const materials = useMemo(() => {
    // above 1.0 so the bloom pass lights them up like the rest of the stadium
    const teal = () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(TEAL).multiplyScalar(2.6),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    return {
      ring: teal(),
      shell: teal(),
      shard: teal(),
      core: new THREE.MeshBasicMaterial({
        color: new THREE.Color(CORE).multiplyScalar(3.4),
        transparent: true,
        depthWrite: false,
      }),
    };
  }, []);

  /** fixed spray of directions, so every goal throws the same confident shape */
  const directions = useMemo(() => {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < SHARDS; i++) {
      // golden-angle spiral: even cover without clumping, and no randomness
      const y = 1 - (i / (SHARDS - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = i * 2.399963;
      out.push(new THREE.Vector3(Math.cos(theta) * r, y * 0.75, Math.sin(theta) * r).normalize());
    }
    return out;
  }, []);

  useFrame((state, rawDt) => {
    const g = useGame.getState();
    const node = group.current;
    if (!node || g.paused) return;
    const st = life.current;

    // arm on a goal, disarm the moment the round is put back on the spot
    if (!g.kick || g.kick.outcome !== 'goal') {
      st.fired = false;
      st.banged = false;
    } else if (g.phase === 'strike') {
      const at = g.clock.flightCross + TRIGGER_AFTER_CROSS;

      // The clip now opens with silence and is scheduled a beat ahead, so it has
      // to be asked for that much sooner or the bang lands after the flash.
      if (!st.banged && g.clock.flight >= at - SAMPLE_LATENCY) {
        st.banged = true;
        playSample(EXPLOSION, 0.75);
      }

      if (!st.fired && g.clock.flight >= at) {
        st.fired = true;
        st.active = true;
        st.t = 0;
        node.position.copy(g.live.ball);
      }
    }

    if (!st.active) {
      if (node.visible) node.visible = false;
      return;
    }

    st.t += Math.min(rawDt, 0.05);
    const k = st.t / LIFE;
    if (k >= 1) {
      st.active = false;
      node.visible = false;
      return;
    }
    node.visible = true;

    // drawn on sixes: the burst holds each pose rather than sliding between them
    const frame = Math.floor(k * FRAMES) / FRAMES;
    const grow = easeOut(frame);
    const fade = 1 - frame;

    if (ring.current) {
      const s = 0.35 + grow * 4.6;
      ring.current.scale.set(s, s, s);
      (ring.current.material as THREE.Material).opacity = fade * 0.85;
      // billboard it, or the shockwave turns edge-on and vanishes. lookAt takes a
      // world-space target and accounts for the parent transform, so this is
      // correct even though the ring hangs off a group parked on the ball.
      ring.current.lookAt(state.camera.position);
    }

    if (shell.current) {
      const s = 0.3 + grow * 1.5;
      shell.current.scale.set(s, s, s);
      (shell.current.material as THREE.Material).opacity = fade * 0.5;
      shell.current.rotation.y += 1.6 * rawDt;
    }

    if (core.current) {
      const s = Math.max(0.001, (1 - grow) * 0.9);
      core.current.scale.set(s, s, s);
      (core.current.material as THREE.Material).opacity = Math.max(0, 1 - frame * 2.2);
    }

    if (shards.current) {
      const reach = 0.4 + grow * 3.1;
      const shrink = Math.max(0.05, 1 - frame * 1.15);
      shards.current.children.forEach((child, i) => {
        const dir = directions[i];
        child.position.copy(dir).multiplyScalar(reach);
        child.scale.set(shrink, shrink * (1 + grow * 1.4), shrink);
      });
      (materials.shard as THREE.Material).opacity = fade;
    }
  });

  return (
    <group ref={group} visible={false}>
      {/* shockwave ring */}
      <mesh ref={ring} material={materials.ring}>
        <ringGeometry args={[0.78, 1, 5]} />
      </mesh>

      {/* faceted shell — an icosahedron at the lowest detail reads as folded paper */}
      <mesh ref={shell} material={materials.shell}>
        <icosahedronGeometry args={[1, 0]} />
      </mesh>

      {/* white-hot core, gone almost immediately */}
      <mesh ref={core} material={materials.core}>
        <icosahedronGeometry args={[1, 0]} />
      </mesh>

      {/* shards thrown outward, each a flat four-sided spike */}
      <group ref={shards}>
        {directions.map((dir, i) => (
          <mesh
            key={i}
            material={materials.shard}
            quaternion={new THREE.Quaternion().setFromUnitVectors(
              new THREE.Vector3(0, 1, 0),
              dir
            )}
          >
            <coneGeometry args={[0.16, 0.72, 4]} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
