import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import { useGame } from '../store';
import { dirX } from '../types';

// Third person, over the striker's right shoulder: back and above him, offset a
// little to his left so he sits right-of-frame and leaves the goal mouth clear.
// The height and distance are what keep the timing ring on screen — from a lower
// or closer angle it falls off the bottom edge, and the ring is the whole game.
const STRIKER_EYE = new THREE.Vector3(-1.5, 3.15, 21.6);
/** short of the goal line, so striker, ball, ring and goal all share the frame */
const STRIKER_LOOK = new THREE.Vector3(0, 0.6, 4.5);
const KEEPER_EYE = new THREE.Vector3(0, 1.74, 0.4);

const _pos = new THREE.Vector3();
const _look = new THREE.Vector3();

/**
 * First-person rig, one camera for both roles. Everything is a damped chase
 * toward a per-phase target, so cuts between phases become smooth swoops.
 */
export function CameraRig() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const scene = useThree((s) => s.scene);
  if (import.meta.env.DEV) {
    const w = window as unknown as { __cam: unknown; __scene: unknown; __THREE: unknown };
    w.__cam = camera;
    w.__scene = scene;
    w.__THREE = THREE;
  }
  const cur = useRef({
    pos: new THREE.Vector3(14, 7, 26),
    look: new THREE.Vector3(0, 1, 0),
    roll: 0,
    fov: 66,
  });

  useFrame((state, rawDt) => {
    if (import.meta.env.DEV && (window as unknown as { __freecam?: boolean }).__freecam) return;
    const g = useGame.getState();
    if (g.paused) return;
    const dt = Math.min(rawDt, 0.05);
    const t = state.clock.elapsedTime;
    const c = cur.current;

    let roll = 0;
    let fov = 66;
    let lambda = 4;

    if (g.screen === 'menu' || g.phase === 'over') {
      // slow cinematic orbit around the goal mouth
      const a = t * 0.12;
      _pos.set(Math.sin(a) * 14, 4.5 + Math.sin(t * 0.3) * 0.6, 8 + Math.cos(a) * 9);
      _look.set(0, 1.4, 4);
      fov = 55;
      lambda = 1.6;
    } else if (g.turn === 'player') {
      // ---- you are the striker
      _pos.copy(STRIKER_EYE);
      _look.copy(STRIKER_LOOK);
      fov = 52;
      if (g.phase === 'intro') {
        // a wider establishing angle before settling behind him
        _pos.set(-5.6, 3.7, 22.4);
        _look.set(0, 1.1, 7);
        fov = 50;
      } else if (g.phase === 'aim') {
        // a slow breathing drift, so the hold before the kick is never dead still
        _pos.x += Math.sin(g.clock.aim * 1.6) * 0.05;
        _pos.y += Math.sin(g.clock.aim * 2.3) * 0.035;
      } else if (g.phase === 'strike' || g.phase === 'result') {
        // ride in behind the run-up, then follow the ball
        _pos.set(-1.2, 2.8, 19.2);
        _look.lerp(g.live.ball, 0.7);
        fov = 56;
        lambda = 5;
      }
    } else {
      // ---- you are the keeper
      _pos.copy(KEEPER_EYE);
      _look.copy(g.live.ball);
      _look.y += 0.55; // watch the ball, chin up a touch
      fov = 72;
      if (g.phase === 'intro') {
        _pos.set(-2.6, 2.0, 2.6);
        _look.set(0, 1.1, 11);
      } else if (g.phase === 'strike' || g.phase === 'result') {
        const k = g.kick;
        const x = k ? dirX(k.guess) : 0;
        const dive = Math.min(1, g.clock.flight / Math.max(g.clock.flightCross, 0.01));
        if (x !== 0) {
          _pos.x += x * 1.55 * dive;
          _pos.y -= 0.5 * dive;
          roll = x * 0.5 * dive;
        } else {
          _pos.y -= 0.18 * dive; // set yourself for the catch
        }
        _look.copy(g.live.ball);
        fov = 74;
        lambda = 8;
      }
    }

    const dl = 1 - Math.exp(-lambda * dt);
    c.pos.lerp(_pos, dl);
    c.look.lerp(_look, dl);
    c.roll += (roll - c.roll) * dl;
    c.fov += (fov - c.fov) * dl;

    camera.position.copy(c.pos);
    camera.lookAt(c.look);
    camera.rotateZ(c.roll);
    if (Math.abs(camera.fov - c.fov) > 0.01) {
      camera.fov = c.fov;
      camera.updateProjectionMatrix();
    }
  });

  return null;
}
