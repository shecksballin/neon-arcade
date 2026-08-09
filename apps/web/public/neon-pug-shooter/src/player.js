import * as THREE from 'three';
import { createCharacter } from './characters.js';
import { LOW_HEALTH, FULL_HEALTH } from './achievements.js';
import { applyCamera, makeRig } from './camera.js';

// --- movement feel (Quake/CS lineage, so bunny hopping actually pays off) ---
const GRAVITY = 20;
const GROUND_ACCEL = 62;
const GROUND_FRICTION = 8.5;
const MAX_GROUND_SPEED = 7.2;
const AIR_ACCEL = 95;
const AIR_WISH_CAP = 1.35;      // the classic air-control cap: strafing adds speed

// --- bunny hopping ---
// Jumping is tap-only: holding space does nothing after the first hop. Land and press
// again inside the window to keep the chain, and every chained hop raises your personal
// speed ceiling. There's no practical cap — the ceiling just climbs — but the gain per
// hop is small, so top speed is earned over a long clean chain rather than handed over.
// Starting a chain is the hard part: the first re-press is nearly frame-perfect and the
// window widens with each hop, so by the fourth you're cruising on a forgiving rhythm.
const BHOP_WINDOW_START = 0.13; // seconds to re-press when continuing a 1-hop chain
const BHOP_WINDOW_MAX = 0.55;   // once the chain is established
const BHOP_LOCKED_AT = 4;       // chain length where the window stops widening
const JUMP_BUFFER = 0.18;       // a press slightly early still fires on landing
const JUMP_COYOTE = 0.12;       // …and slightly late still counts as grounded
const AIR_SPEED_BASE = 17;      // ceiling with no chain going
const BHOP_GAIN = 1.4;          // extra ceiling per chained hop
const BHOP_BOOST = 0.9;         // flat speed handed over per chained hop
const BHOP_MULT = 1.05;         // …plus a slice of what you already had, so it compounds
const BHOP_CEILING = 90;        // sanity stop, not a design limit
const CAP_DECAY = 7;            // how fast the earned ceiling bleeds off once you miss
const JUMP_SPEED = 6.4;
const CROUCH_SPEED = 3.6;
const GROUND_STICK = 1.2;       // downward bias while standing, keeps `grounded` stable
const EYE_HEIGHT = 1.62;

// --- weapon ---
const FIRE_INTERVAL = 0.095;
const MAG_SIZE = 30;
const RESERVE_MAX = 100;        // spare rounds — no longer bottomless
const RELOAD_FALLBACK = 1.7;    // only if the reload sfx's length can't be read
const BASE_DAMAGE = 22;

// Killing is how you resupply: every kill hands back health and rounds, so pushing forward
// sustains you and turtling starves you.
const KILL_HEALTH = 40;
const KILL_AMMO = 40;

// --- recoil ---
// A dead-straight vertical climb — no horizontal component at all, so the pattern is a
// perfect line you can learn and pull down against, the way an F2 behaves. The kick goes
// into the aim itself, not just the camera: a recoil the bullets ignore is decoration.
const RECOIL_PER_SHOT = 0.019;  // radians of climb per round
const RECOIL_MAX = 0.58;        // ~33 degrees, reached around the end of a mag
const RECOIL_RECOVER = 1.6;     // rad/s the view settles back once you stop
// Has to sit above FIRE_INTERVAL, or the gap between two rounds of sustained fire is long
// enough to start the recovery — which cancels the climb and pins the pattern to a single
// shot's worth of kick.
const RECOIL_SETTLE_DELAY = 0.16;

// How long you have to re-press after landing, given the chain you're already on.
// Chain 1 → 0.13s, 2 → 0.27s, 3 → 0.41s, 4+ → 0.55s.
function bhopWindow(chain) {
  if (chain <= 0) return Infinity;          // the first jump is always free
  const t = Math.min(1, (chain - 1) / (BHOP_LOCKED_AT - 1));
  return BHOP_WINDOW_START + (BHOP_WINDOW_MAX - BHOP_WINDOW_START) * t;
}

function accelerate(vel, wishDir, wishSpeed, accel, dt) {
  const current = vel.x * wishDir.x + vel.z * wishDir.z;
  const add = wishSpeed - current;
  if (add <= 0) return;
  const accelSpeed = Math.min(accel * wishSpeed * dt, add);
  vel.x += wishDir.x * accelSpeed;
  vel.z += wishDir.z * accelSpeed;
}

export function createPlayer({ scene, camera, canvas, collision, combat, settings, reloadTime = 0, hooks = {} }) {
  const character = createCharacter({ tint: '#ffffff', gunTint: '#ffffff' });
  scene.add(character.root);

  // The reload runs exactly as long as its sound effect, and the clips are retimed to
  // match — so the animation, the audio and the fresh mag all land on the same frame.
  const RELOAD_TIME = reloadTime > 0.2 ? reloadTime : RELOAD_FALLBACK;
  character.setReloadDuration(RELOAD_TIME);

  const entity = {
    isPlayer: true,
    name: 'you',
    team: 0,
    alive: true,
    health: 100,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    character,
    kills: 0,
    deaths: 0,
    score: 0,
    lastKilledBy: null,   // who put you down last — Revenge reads this
    lowHealthBy: null,    // who last dropped you to LOW_HEALTH — Saviour reads this
  };

  const state = {
    yaw: 0,
    pitch: 0,
    grounded: false,
    crouching: false,
    jumpHeld: false,
    ads: false,
    adsAmount: 0,
    ammo: MAG_SIZE,
    reserve: RESERVE_MAX,
    reloading: 0,
    fireCooldown: 0,
    recoil: new THREE.Vector2(),
    sinceFired: 99,             // recoil only settles once you stop shooting
    shotStreak: 0,
    speed: 0,
    forwardInput: 0,
    strafeInput: 0,
    respawnTimer: 0,
    bhopChain: 0,
    airTime: 0,
    jumpBuffer: 0,              // time left on a fresh space press before it goes stale
    coyoteOk: true,             // may still jump just after walking off an edge
    sinceLanded: 0,             // how long we've been back on the ground
    speedCap: AIR_SPEED_BASE,   // the ceiling earned by the current chain
  };

  const keys = new Set();
  let mouseDown = false;
  let enabled = false;

  // ---- input ----------------------------------------------------------------
  // The renderer canvas is passed in explicitly: querySelector('canvas') would find the
  // HUD's minimap canvas first, and the pointer-lock check would never match.

  let lockFailed = false;
  document.addEventListener('pointerlockerror', () => { lockFailed = true; });

  function onMouseMove(e) {
    if (!enabled) return;
    const locked = document.pointerLockElement === canvas;
    // if the browser refuses pointer lock, fall back to look-while-holding-a-button
    if (!locked && !(lockFailed && (mouseDown || state.ads))) return;
    const sens = settings.sensitivity * (state.ads ? 0.55 : 1) * 0.0022;
    state.yaw -= e.movementX * sens;
    state.pitch -= e.movementY * sens;
    state.pitch = THREE.MathUtils.clamp(state.pitch, -1.45, 1.45);
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mousedown', (e) => {
    if (!enabled) return;
    if (e.button === 0) mouseDown = true;
    if (e.button === 2) state.ads = true;
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouseDown = false;
    if (e.button === 2) state.ads = false;
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    // bhop is tap-only, so buffer on the press edge and ignore auto-repeat
    if (e.code === 'Space' && !e.repeat && !keys.has('Space')) state.jumpBuffer = JUMP_BUFFER;
    keys.add(e.code);
    if (e.code === 'KeyR') reload();
    if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Tab'].includes(e.code)) e.preventDefault();
  });
  document.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => { keys.clear(); mouseDown = false; });

  function reload() {
    // nothing to top up with is the same as nothing to do — the mag stays as it is
    if (state.reloading > 0 || state.ammo === MAG_SIZE || state.reserve <= 0 || !entity.alive) return;
    state.reloading = RELOAD_TIME;
    hooks.onReload?.();
  }

  // A kill pays out health and rounds. Both cap, so the reward is worth most when you're
  // hurt and dry, which is exactly when you'd otherwise be backing off.
  function rewardKill() {
    entity.health = Math.min(100, entity.health + KILL_HEALTH);
    state.reserve = Math.min(RESERVE_MAX, state.reserve + KILL_AMMO);
  }

  // ---- spawn ----------------------------------------------------------------
  function spawn(point) {
    entity.position.copy(point);
    entity.velocity.set(0, 0, 0);
    entity.alive = true;
    entity.health = 100;
    state.ammo = MAG_SIZE;
    state.reserve = RESERVE_MAX;
    state.reloading = 0;
    state.recoil.set(0, 0);
    state.respawnTimer = 0;
    state.bhopChain = 0;
    state.speedCap = AIR_SPEED_BASE;
    state.jumpBuffer = 0;
    state.coyoteOk = true;
    state.sinceLanded = 0;
    entity.lowHealthBy = null;
    character.root.visible = true;
    hooks.onSpawn?.();
  }

  function die(killer) {
    if (!entity.alive) return;
    entity.alive = false;
    entity.deaths++;
    entity.lastKilledBy = killer ?? null;
    state.respawnTimer = 3;
    character.root.visible = false;
    hooks.onDeath?.(killer);
  }

  function takeDamage(amount, from) {
    if (!entity.alive || entity.invulnerable) return;
    entity.health -= amount;
    // remember who walked you to the edge, so a team-mate killing them counts as a save
    if (entity.health > 0 && entity.health <= LOW_HEALTH && from) entity.lowHealthBy = from;
    hooks.onHurt?.(amount, from);
    if (entity.health <= 0) die(from);
  }
  entity.takeDamage = takeDamage;

  // ---- camera ---------------------------------------------------------------
  // The rig itself lives in camera.js, because the killcam has to place its camera the
  // exact same way to look like the game it is replaying.
  const rig = makeRig();

  function updateCamera(dt) {
    applyCamera(camera, {
      position: entity.position,
      yaw: state.yaw + state.recoil.x,
      pitch: aimPitch(),
      ads: state.adsAmount,
      crouching: state.crouching,
      speed: state.speed,
      collision, settings, dt, rig,
    });
  }

  // ---- shooting -------------------------------------------------------------
  const shotOrigin = new THREE.Vector3();
  const shotDir = new THREE.Vector3();
  const muzzleWorld = new THREE.Vector3();

  // Where the player is actually aiming — recoil included, because the climb is the whole
  // point of the pattern. Camera, crosshair and bullet all read this same angle, so the
  // plus stays honest while the muzzle walks up the screen.
  function aimDirection(out = new THREE.Vector3()) {
    const pitch = aimPitch();
    const yaw = state.yaw + state.recoil.x;
    const cp = Math.cos(pitch);
    return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  }

  function aimPitch() {
    return THREE.MathUtils.clamp(state.pitch + state.recoil.y, -1.5, 1.5);
  }

  // world point the crosshair should sit on, for pinning it while the view kicks
  function aimPoint(out = new THREE.Vector3()) {
    camera.getWorldPosition(out);
    const dir = aimDirection();
    return out.addScaledVector(dir, 60);
  }

  // Pinpoint weapon: no spread, and recoil never touches the bullet. The kick below is
  // camera-only, and the crosshair rides the true aim, so every shot lands on the plus.
  function currentSpread() {
    return 0;
  }

  function tryFire(entities) {
    if (!entity.alive || state.fireCooldown > 0 || state.reloading > 0) return;
    if (state.ammo <= 0) { reload(); return; }

    state.fireCooldown = FIRE_INTERVAL;
    state.ammo--;
    state.shotStreak = Math.min(state.shotStreak + 1, 10);
    // straight up, every round the same, no sideways wander
    state.recoil.y = Math.min(RECOIL_MAX, state.recoil.y + RECOIL_PER_SHOT);
    state.sinceFired = 0;
    character.triggerFire();

    camera.getWorldPosition(shotOrigin);
    aimDirection(shotDir);                 // base aim, recoil excluded
    character.muzzle.getWorldPosition(muzzleWorld);

    const result = combat.fire({
      origin: shotOrigin,
      direction: shotDir,
      shooter: entity,
      entities,
      spread: currentSpread(),
      damage: BASE_DAMAGE,
      muzzle: muzzleWorld,
    });

    hooks.onShoot?.(state.ammo);

    if (result) {
      result.victim.takeDamage?.(result.damage, entity);
      hooks.onHitConfirm?.(result);
      if (!result.victim.alive) {
        entity.kills++;
        rewardKill();
        // untouched a moment ago, dead now, from this one bullet
        hooks.onKill?.(result.victim, result.headshot, {
          oneTap: result.victimHealth >= FULL_HEALTH,
        });
      }
    }
  }

  // ---- main step ------------------------------------------------------------
  const wishDir = new THREE.Vector3();
  const forwardVec = new THREE.Vector3();
  const rightVec = new THREE.Vector3();

  function update(dt, entities) {
    if (!entity.alive) {
      state.respawnTimer -= dt;
      updateCamera(dt);
      if (state.respawnTimer <= 0) hooks.onRespawnReady?.();
      return;
    }

    // --- intent
    const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    state.forwardInput = f;
    state.strafeInput = s;
    state.crouching = keys.has('ShiftLeft');

    forwardVec.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    rightVec.set(Math.cos(state.yaw), 0, -Math.sin(state.yaw));
    wishDir.set(0, 0, 0).addScaledVector(forwardVec, f).addScaledVector(rightVec, s);
    const hasInput = wishDir.lengthSq() > 0;
    if (hasInput) wishDir.normalize();

    // tap-only: a buffered press is spent on one jump and never repeats while held.
    // Coyote time means a one-frame stumble off a kerb doesn't disqualify the jump.
    state.jumpBuffer = Math.max(0, state.jumpBuffer - dt);
    const canJump = state.grounded || (state.coyoteOk && state.airTime < JUMP_COYOTE);
    const wantJump = state.jumpBuffer > 0 && canJump;

    // --- horizontal movement
    if (state.grounded) {
      // Friction is held off for as long as you still have time to re-press. Without this
      // the few frames between landing and a human-timed tap scrub off ~14% of speed each,
      // which cancels the hop bonus entirely and the chain never builds.
      const inRhythm = state.bhopChain > 0 && state.sinceLanded <= bhopWindow(state.bhopChain);
      if (!wantJump && !inRhythm) {
        const speed = Math.hypot(entity.velocity.x, entity.velocity.z);
        if (speed > 0.01) {
          const drop = Math.max(speed, 4) * GROUND_FRICTION * dt;
          const scale = Math.max(0, speed - drop) / speed;
          entity.velocity.x *= scale;
          entity.velocity.z *= scale;
        }
      }
      const maxSpeed = state.crouching ? CROUCH_SPEED : MAX_GROUND_SPEED;
      if (hasInput) accelerate(entity.velocity, wishDir, maxSpeed, GROUND_ACCEL, dt);
    } else {
      // air control: only a small wish speed is allowed, so turning while strafing gains speed
      if (hasInput) accelerate(entity.velocity, wishDir, AIR_WISH_CAP, AIR_ACCEL, dt);
      const airSpeed = Math.hypot(entity.velocity.x, entity.velocity.z);
      if (airSpeed > state.speedCap) {
        const k = state.speedCap / airSpeed;
        entity.velocity.x *= k;
        entity.velocity.z *= k;
      }
    }

    // --- jump. Sits outside the grounded branch so a coyote-time press still fires.
    if (wantJump) {
      state.jumpBuffer = 0;
      state.coyoteOk = false;
      // in time with the last landing? keep the chain going, otherwise start over
      state.bhopChain = state.sinceLanded <= bhopWindow(state.bhopChain) && state.bhopChain > 0
        ? state.bhopChain + 1
        : 1;

      // Every chained hop speeds you up along the way you're already travelling: a flat
      // bump plus a slice of your current speed, so the faster you go the more each hop
      // gives. The ceiling is lifted to match, so it never chokes what you've earned.
      const hSpeed = Math.hypot(entity.velocity.x, entity.velocity.z);
      const chainCap = AIR_SPEED_BASE + (state.bhopChain - 1) * BHOP_GAIN;
      let target = hSpeed;
      if (state.bhopChain > 1 && hSpeed > 0.5) target = hSpeed * BHOP_MULT + BHOP_BOOST;

      state.speedCap = Math.min(BHOP_CEILING, Math.max(chainCap, target + 2));
      if (target > hSpeed) {
        const k = Math.min(target, state.speedCap) / hSpeed;
        entity.velocity.x *= k;
        entity.velocity.z *= k;
      }

      entity.velocity.y = JUMP_SPEED;
      state.grounded = false;
      hooks.onJump?.(state.bhopChain);
    } else if (state.grounded && state.sinceLanded > bhopWindow(state.bhopChain)) {
      state.bhopChain = 0;              // missed the window — the chain is over
    }

    // Once the chain breaks the earned ceiling bleeds off rather than snapping back, so
    // losing the rhythm costs you speed gradually instead of instantly.
    if (state.bhopChain === 0 && state.speedCap > AIR_SPEED_BASE) {
      state.speedCap = Math.max(AIR_SPEED_BASE, state.speedCap - CAP_DECAY * dt);
    }

    // Gravity runs every frame, grounded or not. A character controller only reports
    // "grounded" if the movement it's given actually pushes into the floor — hand it a
    // zero vertical step and it reports airborne, which flip-flops the state at 60Hz.
    entity.velocity.y -= GRAVITY * dt;

    // --- move: Rapier sweeps the capsule against the map's real triangles, so walls,
    // kerbs and steps are handled exactly rather than by pushing out of a box
    const wasGrounded = state.grounded;
    const height = state.crouching ? 1.2 : 1.8;
    const grounded = collision.moveCapsule(
      entity, entity.position, 0.42, height,
      entity.velocity.x * dt, entity.velocity.y * dt, entity.velocity.z * dt,
      entity.velocity,        // let the solver slide it along whatever it hits
    );

    if (grounded) {
      // keep a gentle downward bias instead of zeroing, so the next frame still probes
      // into the floor and the grounded flag stays steady
      if (entity.velocity.y < 0) entity.velocity.y = -GROUND_STICK;
      if (!wasGrounded) { hooks.onLand?.(); state.sinceLanded = 0; }
      else state.sinceLanded += dt;
      state.coyoteOk = true;
    }
    // sinceLanded is deliberately left alone while airborne: a one-frame stumble off a
    // kerb shouldn't look like a fresh landing and restart the rhythm timer.
    state.grounded = grounded;
    // Coyote time for the *animation* only: stepping off a kerb drops `grounded` for a
    // frame or two, and without this the walk cycle keeps restarting into the jump clip.
    state.airTime = grounded ? 0 : state.airTime + dt;

    // safety net: if anything ever drops us through the world, put us back on the street
    const floor = collision.groundAt(entity.position.x, entity.position.z);
    if (entity.position.y < floor - 2) {
      entity.position.y = floor;
      entity.velocity.y = 0;
      state.grounded = true;
    }

    state.speed = Math.hypot(entity.velocity.x, entity.velocity.z);

    // --- weapon timers
    state.fireCooldown = Math.max(0, state.fireCooldown - dt);
    if (state.reloading > 0) {
      state.reloading -= dt;
      if (state.reloading <= 0) {
        // the mag is filled out of the spare rounds, not out of thin air
        const taken = Math.min(MAG_SIZE - state.ammo, state.reserve);
        state.ammo += taken;
        state.reserve -= taken;
      }
    }

    // --- recoil settles back down once the trigger is off, so the pattern is repeatable
    state.sinceFired += dt;
    if (state.sinceFired > RECOIL_SETTLE_DELAY && state.recoil.y > 0) {
      state.recoil.y = Math.max(0, state.recoil.y - RECOIL_RECOVER * dt);
    }
    if (!mouseDown) state.shotStreak = Math.max(0, state.shotStreak - dt * 12);
    if (mouseDown) tryFire(entities);

    state.adsAmount = THREE.MathUtils.damp(state.adsAmount, state.ads ? 1 : 0, 16, dt);

    // --- avatar
    character.root.position.copy(entity.position);
    character.root.rotation.y = state.yaw;
    character.poseFromMotion({
      speed: state.speed,
      forward: f,
      strafe: s,
      grounded: state.airTime < 0.12,
      crouching: state.crouching,
      reloading: state.reloading > 0,
    });
    // the gun climbs with the view, so the recoil is visible on the model too
    character.update(dt, { aimPitch: aimPitch(), moveSpeed: state.speed });

    updateCamera(dt);
  }

  return {
    entity,
    state,
    spawn,
    update,
    reload,
    setEnabled(v) { enabled = v; if (!v) { keys.clear(); mouseDown = false; } },
    get bhopLocked() { return state.bhopChain >= BHOP_LOCKED_AT; },
    get aimPitch() { return aimPitch(); },
    aimDirection,
    aimPoint,
    get crosshairSpread() { return currentSpread(); },
    get reloadFraction() { return state.reloading > 0 ? 1 - state.reloading / RELOAD_TIME : 0; },
    eyeHeight: EYE_HEIGHT,
    magSize: MAG_SIZE,
  };
}
