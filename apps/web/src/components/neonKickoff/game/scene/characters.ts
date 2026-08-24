import * as THREE from 'three';

/**
 * Fit a character to a target height with its feet on y=0, and return the
 * offset applied so callers can reason about where the model actually sits.
 */
export function normalizeCharacter(root: THREE.Object3D, height: number, kit = '#ff2f86') {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const scale = height / Math.max(size.y, 1e-4);
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);

  const scaled = new THREE.Box3().setFromObject(root);
  root.position.y -= scaled.min.y;

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.castShadow = true;
    // dives fling limbs well outside the bind pose, which culls the whole mesh
    obj.frustumCulled = false;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      const m = mat as THREE.MeshStandardMaterial;
      if (!m.map) {
        // The Mixamo exports ship untextured, so both AI players wear the away
        // kit — the same magenta the HUD uses for the opponent — with a little
        // emissive so they read against a dark pitch instead of silhouetting.
        m.color = new THREE.Color(kit);
        m.emissive = new THREE.Color(kit);
        m.emissiveIntensity = 0.22;
        m.roughness = 0.55;
        m.metalness = 0.05;
      }
    }
  });

  return scale;
}

/**
 * Play one clip once and hold its final pose.
 *
 * Deliberately fadeIn/fadeOut rather than crossFadeTo: a cross-fade only works
 * once both actions are already running, and here the incoming clip is being
 * started from cold on the same frame.
 */
export function playOnce(
  action: THREE.AnimationAction | null | undefined,
  from?: THREE.AnimationAction | null,
  timeScale = 1
) {
  if (!action) return;
  if (from && from !== action) from.fadeOut(0.12);
  action.stop();
  action.reset();
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.enabled = true;
  action.timeScale = timeScale;
  action.setEffectiveWeight(1);
  action.fadeIn(0.08);
  action.play();
}

/** return to a looping idle, fading out whatever else is running */
export function playIdle(
  idle: THREE.AnimationAction | null | undefined,
  others: (THREE.AnimationAction | null | undefined)[]
) {
  if (!idle) return;
  for (const a of others) a?.fadeOut(0.22);
  idle.reset();
  idle.setLoop(THREE.LoopRepeat, Infinity);
  idle.setEffectiveWeight(1);
  idle.enabled = true;
  idle.fadeIn(0.22).play();
}

/**
 * T-pose guard.
 *
 * A rig with no action holding any weight falls back to its bind pose, which on
 * a Mixamo character is a T-pose. That happens more easily than it looks: a
 * character can mount while the round is mid-flight and miss its cue, or the
 * clips can bind a frame after the first effect runs, and nothing ever starts
 * the idle. Checking weight rather than isRunning matters — a clip that has
 * finished under clampWhenFinished is paused but still holding its last pose,
 * and must not be interrupted.
 *
 * It snaps the idle on at full weight instead of fading it. That is the whole
 * reason this guard works. A fade-in starts at zero weight and this runs every
 * frame, so a faded recovery reads back a weight of roughly dt/0.22 on the next
 * frame — which at a high refresh rate, or any frame where the mixer has barely
 * advanced, is still under the threshold. The guard would fire again, restart the
 * fade from zero, and hold the rig on its bind pose indefinitely: the T-pose it
 * exists to prevent. There is nothing to blend from in any case, because by
 * definition nothing was playing.
 */
export function ensureIdle(
  actions: Record<string, THREE.AnimationAction | null | undefined>,
  idleName = 'idle'
): boolean {
  const idle = actions[idleName];
  if (!idle) return false;
  for (const key in actions) {
    const a = actions[key];
    if (a && a.getEffectiveWeight() > 0.01) return false;
  }
  idle.reset();
  idle.setLoop(THREE.LoopRepeat, Infinity);
  idle.enabled = true;
  idle.setEffectiveWeight(1);
  idle.play();
  return true;
}
