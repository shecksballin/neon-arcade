import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { BallCollider, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { makeFlight, type FlightPath } from '../flight';
import { useGame } from '../store';
import { BALL_R, SPOT } from '../types';

const _pos = new THREE.Vector3();
const _prev = new THREE.Vector3();

/**
 * The match ball, on a scripted flight path.
 *
 * The path is authored rather than simulated, so a shot always finishes exactly
 * where the round says it should — in the corner the player picked, in the
 * keeper's gloves, or over the bar.
 *
 * It is still a rigid body, but a kinematic one: kinematic bodies push dynamic
 * ones and are never pushed back, so the ball bullies the net around on its way
 * in while its own path stays exactly as authored. Moving it with
 * setNextKinematicTranslation rather than teleporting it is what gives rapier
 * the implied velocity, and so the net a shove proportional to the strike.
 */
export function Ball() {
  const { scene } = useGLTF('/neon-kickoff/ball.glb');
  const body = useRef<RapierRigidBody>(null);
  const spin = useRef<THREE.Group>(null);
  const kick = useGame((s) => s.kick);

  const model = useMemo(() => {
    const root = scene;
    // the Sketchfab export ships a giant floor plane alongside the ball
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = true;
      if (/floor/i.test(o.name)) o.visible = false;
    });
    const floor = root.getObjectByName('Floor');
    if (floor) floor.visible = false;

    // normalise whatever units it shipped in to a regulation 22cm ball, centred
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    root.scale.multiplyScalar((BALL_R * 2) / Math.max(size.x, size.y, size.z, 1e-4));
    const scaled = new THREE.Box3().setFromObject(root);
    root.position.sub(scaled.getCenter(new THREE.Vector3()));
    return root;
  }, [scene]);

  const path = useMemo<FlightPath | null>(() => (kick ? makeFlight(kick) : null), [kick]);

  useEffect(() => {
    if (kick) return;
    // setTranslation, NOT setNextKinematicTranslation — see the frame loop
    body.current?.setTranslation({ x: SPOT.x, y: SPOT.y, z: SPOT.z }, true);
    spin.current?.rotation.set(0, 0, 0);
  }, [kick]);

  useFrame(() => {
    const g = useGame.getState();
    const rb = body.current;
    if (!rb || g.paused) return;

    _prev.copy(g.live.ball);
    const inFlight =
      (g.phase === 'strike' || g.phase === 'result' || g.phase === 'over') && !!path;

    if (inFlight) {
      // any t <= 0 parks it on the spot, which is the striker's run-up
      path.at(g.clock.flight, _pos);
    } else {
      _pos.copy(SPOT);
    }

    if (inFlight) {
      // Following the path: rapier derives this body's velocity from where it is
      // and where it is going next, and that derived velocity is what shoves the
      // netting. This is the call that makes the net react at all.
      rb.setNextKinematicTranslation({ x: _pos.x, y: _pos.y, z: _pos.z });
    } else {
      // Going back on the spot between rounds is a jump, not a movement. Asking
      // for it 'next' would have rapier infer the velocity that covers a dozen
      // metres in one step — hundreds of m/s — and drive it through the net on
      // the way out, flinging whichever nodes the ball was resting against.
      // setTranslation writes the body's next position too, so nothing is implied.
      rb.setTranslation({ x: _pos.x, y: _pos.y, z: _pos.z }, true);
    }

    // roll on the inner group: the body owns its own transform, children keep theirs
    const dist = _pos.distanceTo(_prev);
    if (dist > 1e-5 && spin.current) spin.current.rotation.x -= dist / BALL_R;

    // hand the camera and the keeper the live position
    g.live.ball.copy(_pos);
  });

  return (
    <RigidBody
      ref={body}
      type="kinematicPosition"
      colliders={false}
      position={[SPOT.x, SPOT.y, SPOT.z]}
      ccd
    >
      <BallCollider args={[BALL_R]} />
      <group ref={spin}>
        <primitive object={model} />
      </group>
    </RigidBody>
  );
}

useGLTF.preload('/neon-kickoff/ball.glb');
