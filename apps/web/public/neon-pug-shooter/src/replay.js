import * as THREE from 'three';
import { applyCamera, makeRig, cameraAnchor, cameraDesired } from './camera.js';

// Rolling transform recorder + killcam playback.
// Every entity's position/facing/aim is sampled at a fixed rate and every shot is logged,
// so a death can be replayed from the killer's own view — their aim, their misses, their
// tracers. Long enough history to also cut a 10-second final-kill montage.
const HISTORY_SECONDS = 14;
const SAMPLE_HZ = 30;

export function createReplay({
  camera, yawOf, pitchOf = () => 0, crouchOf = () => false, adsOf = () => 0,
  collision = null, settings = null, onShot = null,
}) {
  const frames = [];
  const shots = [];
  let accum = 0;
  let playback = null;

  function record(dt, entities, elapsed) {
    accum += dt;
    if (accum < 1 / SAMPLE_HZ) return;
    accum = 0;
    frames.push({
      t: elapsed,
      entries: entities.map((e) => ({
        entity: e,
        x: e.position.x, y: e.position.y, z: e.position.z,
        yaw: yawOf(e),
        pitch: pitchOf(e),
        // stance rides along too: the camera drops for a crouch and pulls in for an aim,
        // and without these the replay would frame the shot differently to the game
        crouching: crouchOf(e),
        ads: adsOf(e),
        alive: e.alive,
      })),
    });
    while (frames.length && frames[0].t < elapsed - HISTORY_SECONDS) frames.shift();
    while (shots.length && shots[0].t < elapsed - HISTORY_SECONDS) shots.shift();
  }

  // every bullet fired by anyone — plus what it hit, so the replay can re-stage the
  // shooter's own HUD feedback (damage numbers, hitmarker, kill notification)
  function recordShot({ shooter, origin, end, muzzle, hit }, elapsed) {
    shots.push({
      t: elapsed,
      shooter,
      origin: origin.clone(),
      end: end.clone(),
      muzzle: muzzle ? muzzle.clone() : null,
      hit: hit ? {
        victim: hit.victim,
        dealt: hit.dealt,
        headshot: hit.headshot,
        lethal: hit.lethal,
        point: hit.point.clone(),
      } : null,
    });
  }

  function sample(t) {
    if (!frames.length) return null;
    let i = frames.length - 1;
    while (i > 0 && frames[i].t > t) i--;
    const a = frames[i];
    const b = frames[Math.min(i + 1, frames.length - 1)];
    const span = b.t - a.t;
    const k = span > 0.0001 ? THREE.MathUtils.clamp((t - a.t) / span, 0, 1) : 0;

    const out = new Map();
    for (const entry of a.entries) {
      const later = b.entries.find((e) => e.entity === entry.entity) || entry;
      let dYaw = later.yaw - entry.yaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      out.set(entry.entity, {
        position: new THREE.Vector3(
          THREE.MathUtils.lerp(entry.x, later.x, k),
          THREE.MathUtils.lerp(entry.y, later.y, k),
          THREE.MathUtils.lerp(entry.z, later.z, k),
        ),
        yaw: entry.yaw + dYaw * k,
        pitch: THREE.MathUtils.lerp(entry.pitch, later.pitch, k),
        crouching: entry.crouching,
        ads: THREE.MathUtils.lerp(entry.ads ?? 0, later.ads ?? 0, k),
        // the victim is dead in the newest frames — keep them on screen until the shot lands
        alive: entry.alive,
        speed: span > 0.0001
          ? Math.hypot(later.x - entry.x, later.z - entry.z) / span
          : 0,
      });
    }
    return out;
  }

  /**
   * mode 'pov'   — the killcam: sit on the killer's shoulder looking down their aim.
   * mode 'final' — the closing montage: a chase camera that eases into the POV rig for
   *                the last beat. Both replay the recorded tracers.
   */
  function start({ victim, killer, duration = 2.6, elapsed, endAt = elapsed, entities, mode = 'pov' }) {
    if (!frames.length) return false;
    // `to` runs past the moment of the kill: main.js holds the cam back for a couple of
    // seconds first, so the recorder banks the aftermath and the replay ends on real
    // footage rather than a freeze-frame. sample() holds the last known pose for any time
    // past the newest frame, so an early `to` can never outrun the history.
    const to = endAt;
    const from = Math.max(frames[0].t, to - duration);
    playback = {
      victim,
      killer: killer && killer !== victim ? killer : null,
      mode,
      from,
      to,
      time: from,
      lastTime: from,
      entities,
      duration: to - from,
      // its own rig state, so the cam doesn't inherit however far the player's camera
      // happened to be pulled in around cover at the moment they died
      rig: makeRig(),
      firstFrame: true,
    };
    return playback.duration > 0.4;
  }

  const AIM_DISTANCE = 60;              // matches player.aimPoint()

  const camTarget = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const povPos = new THREE.Vector3();
  const camAnchor = new THREE.Vector3();
  const aimWorld = new THREE.Vector3();
  let aimValid = false;                 // false when nobody's aim is being followed
  const chasePos = new THREE.Vector3();
  const aimDir = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const side = new THREE.Vector3();
  const lookAt = new THREE.Vector3();

  // returns progress 0..1, or null when nothing is playing
  function update(dt) {
    if (!playback) return null;
    playback.time += dt;
    const t = Math.min(playback.time, playback.to);
    const pose = sample(t);
    if (!pose) return null;

    for (const entity of playback.entities) {
      const p = pose.get(entity);
      const character = entity.character;
      if (!character || !p) continue;
      character.root.visible = p.alive;
      character.root.position.copy(p.position);
      character.root.rotation.y = p.yaw;
      character.poseFromMotion({
        speed: p.speed,
        forward: 1,
        strafe: 0,
        grounded: true,
        crouching: p.crouching,
      });
      character.update(dt, { aimPitch: p.pitch, moveSpeed: p.speed });
    }

    // re-fire the shots that fall in this slice of the timeline
    if (onShot && playback.time <= playback.to + 0.05) {
      for (const shot of shots) {
        if (shot.t <= playback.lastTime || shot.t > t) continue;
        if (playback.mode === 'pov' && playback.killer && shot.shooter !== playback.killer) continue;
        onShot(shot);
      }
    }
    playback.lastTime = t;

    const victimPose = pose.get(playback.victim);
    const killerPose = playback.killer ? pose.get(playback.killer) : null;
    const progress = THREE.MathUtils.clamp((playback.time - playback.from) / playback.duration, 0, 1);

    aimValid = false;

    if (killerPose) {
      // where the killer was actually looking, frame by frame
      const cp = Math.cos(killerPose.pitch);
      aimDir.set(-Math.sin(killerPose.yaw) * cp, Math.sin(killerPose.pitch), -Math.cos(killerPose.yaw) * cp);
      forward.set(-Math.sin(killerPose.yaw), 0, -Math.cos(killerPose.yaw));
      side.set(Math.cos(killerPose.yaw), 0, -Math.sin(killerPose.yaw));
      aimValid = true;

      // The exact rig the game puts behind that pose — same offsets, same crouch dip, same
      // aim-down-sights pull-in. Nothing here reinvents it.
      cameraAnchor(camAnchor, killerPose.position, killerPose);
      cameraDesired(povPos, camAnchor, killerPose.yaw, killerPose.pitch, killerPose.ads);

      if (playback.mode === 'final') {
        // wide chase for the build-up, easing into the POV for the kill itself
        chasePos.copy(killerPose.position)
          .addScaledVector(forward, -4.2)
          .addScaledVector(side, 1.6);
        chasePos.y += 2.6;
        const k = THREE.MathUtils.smoothstep(progress, 0.62, 0.92);
        camPos.copy(chasePos).lerp(povPos, k);
        lookAt.copy(killerPose.position).setY(killerPose.position.y + 1.5);
        if (victimPose) lookAt.lerp(
          camTarget.copy(victimPose.position).setY(victimPose.position.y + 1.3), k * 0.85);
      } else {
        // The death cam *is* the game: hand the recorded pose straight to the same rig the
        // live camera uses, then park the crosshair on its aim exactly as the HUD does.
        applyCamera(camera, {
          position: killerPose.position,
          yaw: killerPose.yaw,
          pitch: killerPose.pitch,
          ads: killerPose.ads,
          crouching: killerPose.crouching,
          speed: killerPose.speed,
          collision, settings, dt, rig: playback.rig, snap: playback.firstFrame,
        });
        playback.firstFrame = false;
        aimWorld.copy(camera.position).addScaledVector(aimDir, AIM_DISTANCE);
        return progress;              // the rig placed the camera; nothing left to do
      }
    } else if (victimPose) {
      // no killer to follow (fall damage, suicide): slow orbit of the body
      const angle = progress * 1.3;
      camPos.set(
        victimPose.position.x + Math.cos(angle) * 4.2,
        victimPose.position.y + 2.6,
        victimPose.position.z + Math.sin(angle) * 4.2,
      );
      lookAt.copy(victimPose.position).setY(victimPose.position.y + 1.3);
    }

    if (killerPose || victimPose) {
      // don't let a wall sit between the camera and what it's watching
      if (collision) {
        const anchor = killerPose ? killerPose.position : victimPose.position;
        camTarget.copy(anchor).setY(anchor.y + 1.5);
        const toCam = camPos.clone().sub(camTarget);
        const dist = toCam.length();
        if (dist > 0.01) {
          toCam.divideScalar(dist);
          const wall = collision.rayHit(camTarget, toCam, dist + 0.2);
          if (wall !== null) camPos.copy(camTarget).addScaledVector(toCam, Math.max(0.5, wall - 0.25));
        }
      }
      camera.position.copy(camPos);
      camera.lookAt(lookAt);

      // The crosshair rides the killer's aim, projected out from wherever this camera
      // ended up. In the over-the-shoulder framing that lands it exactly where the game
      // parks it; during the final cam's wide chase it slides in as the shot lines up.
      if (aimValid) aimWorld.copy(camera.position).addScaledVector(aimDir, AIM_DISTANCE);
    }

    return progress;   // exactly 1 means "done" to the caller
  }

  // World point the followed killer's crosshair sat on; null when there's no aim to follow
  // (a fall or a suicide, where the cam just orbits the body).
  function aimPoint(out) {
    if (!playback || !aimValid) return null;
    return out.copy(aimWorld);
  }

  function stop() {
    if (!playback) return;
    aimValid = false;
    for (const entity of playback.entities) {
      if (entity.character) entity.character.root.visible = entity.alive;
    }
    playback = null;
  }

  return {
    record,
    recordShot,
    start,
    update,
    aimPoint,
    stop,
    get active() { return !!playback; },
    get mode() { return playback?.mode ?? null; },
    get stats() {
      return {
        frames: frames.length,
        span: frames.length ? +(frames[frames.length - 1].t - frames[0].t).toFixed(2) : 0,
        newest: frames.length ? +frames[frames.length - 1].t.toFixed(2) : 0,
        shots: shots.length,
      };
    },
    clear() { frames.length = 0; shots.length = 0; playback = null; },
  };
}
