import * as THREE from 'three';

// The third-person camera rig.
//
// This lives on its own because two places need it and they must not disagree: the live
// game, and the killcam replaying someone else's screen. When the killcam kept its own
// copy of these numbers it drifted — a tighter shoulder, no pitch in the offset, no crouch
// dip, no FOV — and the replay stopped looking like the game it was replaying. One rig,
// called from both, cannot drift.

const BACK = 3.2, BACK_ADS = 1.6;
const SIDE = 0.88, SIDE_ADS = 0.72;
const RISE = 1.66, RISE_ADS = 1.63;
const CROUCH_DROP = 0.45;
const WALL_PAD = 0.3, WALL_INSET = 0.25, WALL_MIN = 0.6;
const PULL_DAMP = 18;          // how fast the camera slides in and out around cover
const FOV_DAMP = 10;
const SPEED_FOV_FROM = 7.2;    // MAX_GROUND_SPEED — the FOV starts widening past this
const SPEED_FOV_SCALE = 0.6, SPEED_FOV_MAX = 12;

const _target = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _toCam = new THREE.Vector3();

/** Where the camera looks from and pivots around: the shoulder line, dropped for a crouch. */
export function cameraAnchor(out, position, { ads = 0, crouching = false } = {}) {
  out.copy(position);
  out.y += THREE.MathUtils.lerp(RISE, RISE_ADS, ads) - (crouching ? CROUCH_DROP : 0);
  return out;
}

/** Where it would sit with nothing in the way — back along the aim, out to the right. */
export function cameraDesired(out, anchor, yaw, pitch, ads = 0) {
  const back = THREE.MathUtils.lerp(BACK, BACK_ADS, ads);
  const side = THREE.MathUtils.lerp(SIDE, SIDE_ADS, ads);
  _dir.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  _right.set(Math.cos(yaw), 0, -Math.sin(yaw));
  return out.copy(anchor).addScaledVector(_dir, -back).addScaledVector(_right, side);
}

/**
 * Place the camera for a pose. `rig` carries the damped state between frames — give the
 * live player one and each replay its own, so a killcam starting mid-match doesn't inherit
 * however far the player's camera happened to be pulled in when they died.
 */
export function makeRig() {
  return { distance: BACK };
}

export function applyCamera(camera, {
  position, yaw, pitch, ads = 0, crouching = false, speed = 0,
  collision, settings, dt, rig, snap = false,
}) {
  camera.rotation.set(pitch, yaw, 0);

  cameraAnchor(_target, position, { ads, crouching });
  cameraDesired(_desired, _target, yaw, pitch, ads);

  // don't let the camera clip through walls
  _toCam.copy(_desired).sub(_target);
  const dist = _toCam.length();
  _toCam.divideScalar(dist);
  const wall = collision.rayHit(_target, _toCam, dist + WALL_PAD);
  const allowed = wall === null ? dist : Math.max(WALL_MIN, wall - WALL_INSET);
  rig.distance = snap ? allowed : THREE.MathUtils.damp(rig.distance, allowed, PULL_DAMP, dt);
  camera.position.copy(_target).addScaledVector(_toCam, rig.distance);

  // fov + the stretched-FOV projection squeeze
  const targetFov = THREE.MathUtils.lerp(settings.fov, settings.adsFov, ads);
  const speedKick = THREE.MathUtils.clamp(
    (speed - SPEED_FOV_FROM) * SPEED_FOV_SCALE, 0, SPEED_FOV_MAX);
  camera.fov = snap ? targetFov + speedKick
                    : THREE.MathUtils.damp(camera.fov, targetFov + speedKick, FOV_DAMP, dt);
  camera.aspect = window.innerWidth / window.innerHeight;
  // Rebuild the projection (and the manual stretched inverse) only when an input actually
  // moved — the damped fov sits still most of the time and aspect only changes on resize.
  // The stretch multiply must live inside the guard or it would compound every frame.
  const proj = camera.userData.projCache
    ?? (camera.userData.projCache = { fov: Infinity, aspect: 0, stretch: 0 });
  if (Math.abs(proj.fov - camera.fov) > 1e-4
      || proj.aspect !== camera.aspect || proj.stretch !== settings.stretch) {
    proj.fov = camera.fov;
    proj.aspect = camera.aspect;
    proj.stretch = settings.stretch;
    camera.updateProjectionMatrix();
    camera.projectionMatrix.elements[0] *= settings.stretch;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }
}
