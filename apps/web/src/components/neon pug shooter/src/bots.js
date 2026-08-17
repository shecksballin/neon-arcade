import * as THREE from 'three';
import { createCharacter } from './characters.js';
import { DIFFICULTIES, DEFAULT_DIFFICULTY } from './difficulty.js';
import { LOW_HEALTH } from './achievements.js';

const GRAVITY = 20;
const ACCEL = 30;
const FRICTION = 8;
const BASE_MAX_SPEED = 6.4;
const JUMP_SPEED = 6.2;
const GROUND_STICK = 1.2;       // matches player.js — keeps the grounded flag steady
// Bots carry a finite pouch too. They have no reload cycle, so it's one flat pool that
// refills when they respawn — a bot that burns through it goes quiet until it dies.
const BOT_AMMO = 100;

// Where a bot points, in metres above the target's feet. Center mass is the honest aim —
// nobody tracking a moving target goes for the head — so the head is only used when a
// deliberate headshot has been earned. Matches combat.js's hitbox.
const CENTER_MASS = 1.05;
const HEAD_HEIGHT = 1.66;
const HEAD_AIM_SPREAD = 0.15;   // a shot taken on purpose is a much steadier one

const NAMES = ['Biscuit', 'Nacho', 'Waffles', 'Pickle', 'Muffin', 'Gizmo', 'Tofu', 'Peanut', 'Mochi', 'Bagel'];
let nameCursor = 0;

const UP = new THREE.Vector3(0, 1, 0);

export function createBot({ scene, collision, combat, team = 1, tint = '#ffffff', teamGlow = null, skill = 0.6,
                            difficulty = DEFAULT_DIFFICULTY }) {
  const rules = DIFFICULTIES[difficulty] ?? DIFFICULTIES[DEFAULT_DIFFICULTY];
  const character = createCharacter({ tint, gunTint: '#ffffff', teamGlow });
  scene.add(character.root);

  const entity = {
    isBot: true,
    name: NAMES[nameCursor++ % NAMES.length],
    team,
    alive: true,
    health: 100,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    character,
    kills: 0,
    deaths: 0,
    score: 0,
    ammo: BOT_AMMO,
    respawnTimer: 0,
    lastKilledBy: null,
    lowHealthBy: null,    // Saviour reads this off the player's team-mates
  };

  const ai = {
    yaw: 0,
    pitch: 0,
    clock: Math.random() * 100,      // desynced so bots don't wander in phase
    target: null,
    thinkTimer: 0,
    waypoint: null,
    burst: 0,
    burstCooldown: 0,
    fireCooldown: 0,
    reaction: 0,
    settle: 0,                       // how long the aim has rested on this target
    burstBias: new THREE.Vector3(),  // per-spray systematic drift
    strafeDir: Math.random() < 0.5 ? 1 : -1,
    strafeTimer: 0,
    jumpTimer: 0,
    grounded: false,
    airTime: 0,
    pauseTimer: 0,                   // standing around, like a person getting their bearings
    lastSeen: 0,
    moveDir: new THREE.Vector3(),    // smoothed movement intent — curves, not corners
    targetVel: new THREE.Vector3(),
    lastTargetPos: new THREE.Vector3(),
    hasTargetHistory: false,
    stuckTimer: 0,                   // time spent wanting to move but not moving
    stuckFrom: new THREE.Vector3(),  // where the current progress window started
    escapeDir: new THREE.Vector3(),  // committed sidestep while unwedging
    escapeTimer: 0,
    escapeSide: 1,
    // body shots landed since this bot last took someone's head off. Deliberately not
    // reset on respawn — the budget belongs to the bot, not to one of its lives.
    bodyHits: 0,
  };

  // personality: skill sets the sharpness, randomness makes each bot its own player
  const accuracy = THREE.MathUtils.lerp(0.055, 0.014, skill);   // settled spread
  const reactionTime = THREE.MathUtils.lerp(0.6, 0.18, skill);
  const settleTime = THREE.MathUtils.lerp(1.2, 0.45, skill);    // time to steady the aim
  const trackLag = THREE.MathUtils.lerp(0.3, 0.09, skill);      // aim trails a mover by this long
  const burstSize = Math.round(THREE.MathUtils.lerp(3, 7, skill));
  const engageRange = THREE.MathUtils.lerp(38, 70, skill);
  const maxSpeed = BASE_MAX_SPEED * (0.92 + Math.random() * 0.12);
  const turnRate = THREE.MathUtils.lerp(5.5, 9.5, skill);       // rad/s in combat
  const wanderPhase = Math.random() * Math.PI * 2;

  const eye = new THREE.Vector3();
  const targetEye = new THREE.Vector3();
  const toTarget = new THREE.Vector3();
  const aimPoint = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const wishDir = new THREE.Vector3();
  const muzzleWorld = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const escapeProbe = new THREE.Vector3();
  const escapeAlt = new THREE.Vector3();
  const wideAxis = new THREE.Vector3();

  function spawn(point) {
    entity.position.copy(point);
    entity.velocity.set(0, 0, 0);
    entity.alive = true;
    entity.health = 100;
    entity.respawnTimer = 0;
    entity.ammo = BOT_AMMO;
    ai.target = null;
    ai.waypoint = null;
    ai.settle = 0;
    ai.pauseTimer = 0;
    ai.moveDir.set(0, 0, 0);
    ai.hasTargetHistory = false;
    ai.stuckTimer = 0;
    ai.escapeTimer = 0;
    ai.stuckFrom.copy(point);
    entity.lowHealthBy = null;
    character.root.visible = true;
  }

  function die(killer) {
    if (!entity.alive) return;
    entity.alive = false;
    entity.deaths++;
    entity.lastKilledBy = killer ?? null;
    entity.respawnTimer = 3;
    character.root.visible = false;
    entity.onDeath?.(killer);
  }

  entity.takeDamage = (amount, from) => {
    if (!entity.alive || entity.invulnerable) return;
    entity.health -= amount;
    // who walked them to the edge — a team-mate killing that attacker is a save
    if (entity.health > 0 && entity.health <= LOW_HEALTH && from) entity.lowHealthBy = from;
    // getting shot snaps attention but not aim — the settle timer starts over
    if (from && ai.target !== from) {
      ai.target = from;
      ai.reaction = reactionTime * 0.6;
      ai.settle = 0;
      ai.hasTargetHistory = false;
    }
    if (entity.health <= 0) die(from);
  };

  function eyePosition(e, out) {
    return out.copy(e.position).setY(e.position.y + 1.6);
  }

  function pickTarget(entities) {
    let best = null;
    let bestScore = Infinity;
    eyePosition(entity, eye);
    for (const other of entities) {
      if (other === entity || !other.alive) continue;
      if (other.team != null && other.team === entity.team) continue;
      eyePosition(other, targetEye);
      const dist = eye.distanceTo(targetEye);
      if (dist > engageRange) continue;
      if (!collision.lineOfSight(eye, targetEye)) continue;
      if (dist < bestScore) { bestScore = dist; best = other; }
    }
    return best;
  }

  function think(dt, entities) {
    ai.thinkTimer -= dt;
    if (ai.thinkTimer > 0) return;
    ai.thinkTimer = 0.18 + Math.random() * 0.12;

    const found = pickTarget(entities);
    if (found) {
      if (ai.target !== found) {
        ai.reaction = reactionTime * (0.8 + Math.random() * 0.5);
        ai.settle = 0;
        ai.hasTargetHistory = false;
      }
      ai.target = found;
      ai.lastSeen = 0;
      ai.pauseTimer = 0;
    } else if (ai.target) {
      ai.lastSeen += 0.3;
      if (ai.lastSeen > 2.5) ai.target = null;
    }

    if (!ai.target && (!ai.waypoint || entity.position.distanceTo(ai.waypoint) < 3)) {
      // arrived — sometimes linger and look around before the next stroll
      if (ai.waypoint && Math.random() < 0.35) ai.pauseTimer = 0.6 + Math.random() * 1.5;
      ai.waypoint = collision.findOpenPoint();
    }
  }

  function steer(dt) {
    desired.set(0, 0, 0);

    if (ai.pauseTimer > 0) {
      ai.pauseTimer -= dt;
      // stand still; facing drifts in update() like an idle glance
    } else if (ai.target && ai.target.alive) {
      toTarget.subVectors(ai.target.position, entity.position);
      const dist = toTarget.length();
      toTarget.y = 0;
      toTarget.normalize();

      // hold a fighting distance and circle-strafe
      if (dist > 16) desired.add(toTarget);
      else if (dist < 7) desired.sub(toTarget);

      ai.strafeTimer -= dt;
      if (ai.strafeTimer <= 0) {
        ai.strafeTimer = 1.1 + Math.random() * 1.6;
        ai.strafeDir *= -1;
      }
      tmp.set(-toTarget.z, 0, toTarget.x).multiplyScalar(ai.strafeDir);
      desired.add(tmp);

      ai.jumpTimer -= dt;
      if (ai.jumpTimer <= 0 && ai.grounded && Math.random() < 0.35) {
        entity.velocity.y = JUMP_SPEED;
        ai.grounded = false;
        ai.jumpTimer = 1.2 + Math.random();
      }
    } else if (ai.waypoint) {
      toTarget.subVectors(ai.waypoint, entity.position);
      toTarget.y = 0;
      if (toTarget.lengthSq() > 0.01) {
        desired.copy(toTarget).normalize();
        // lazy curve instead of a beeline
        desired.applyAxisAngle(UP, Math.sin(ai.clock * 0.7 + wanderPhase) * 0.4);
      }
    }

    if (desired.lengthSq() > 0) {
      desired.normalize();
      // obstacle avoidance: if the way ahead is blocked, fan out for a clear heading
      const probe = tmp.set(entity.position.x, entity.position.y + 0.9, entity.position.z);
      if (collision.rayHit(probe, desired, 2.6) !== null) {
        const save = desired.clone();
        for (const angle of [0.6, -0.6, 1.2, -1.2, 2.0, -2.0]) {
          desired.copy(save).applyAxisAngle(UP, angle);
          if (collision.rayHit(probe, desired, 2.6) === null) break;
        }
      }
    }

    // An escape already in progress overrides everything — committing to one side for a
    // beat is what actually breaks a snag; re-deciding every frame just jitters in place.
    if (ai.escapeTimer > 0) {
      ai.escapeTimer -= dt;
      desired.copy(ai.escapeDir);
    }

    // fluid: intent has momentum, so direction changes are arcs, and starts/stops ease
    ai.moveDir.lerp(desired, 1 - Math.exp(-dt * 4.5));
    wishDir.copy(ai.moveDir);
  }

  // Wanting to move but going nowhere means we're wedged on something — a kerb, a lamp
  // post, a corner, another bot. Sidestep toward whichever side has room.
  function detectStuck(dt) {
    const wantsToMove = wishDir.lengthSq() > 0.04;
    const speed = Math.hypot(entity.velocity.x, entity.velocity.z);

    if (ai.escapeTimer > 0 || !wantsToMove || !ai.grounded) {
      ai.stuckTimer = 0;
      ai.stuckFrom.copy(entity.position);
      return;
    }

    // progress over the sample window, not instantaneous speed: sliding along a wall
    // still counts as getting somewhere
    ai.stuckTimer += dt;
    if (ai.stuckTimer < 0.45) return;

    const travelled = Math.hypot(
      entity.position.x - ai.stuckFrom.x,
      entity.position.z - ai.stuckFrom.z,
    );
    ai.stuckTimer = 0;
    ai.stuckFrom.copy(entity.position);
    if (travelled > 0.55 && speed > 0.8) return;    // moving fine

    // pick the side with more clearance, and bias to keep the last choice so a bot in a
    // dead end sweeps one way instead of ping-ponging
    const probe = tmp.set(entity.position.x, entity.position.y + 0.9, entity.position.z);
    const left = escapeProbe.set(-wishDir.z, 0, wishDir.x).normalize();
    const leftRoom = collision.rayHit(probe, left, 4) ?? 4;
    const right = escapeAlt.copy(left).multiplyScalar(-1);
    const rightRoom = collision.rayHit(probe, right, 4) ?? 4;

    const preferLeft = Math.abs(leftRoom - rightRoom) < 0.4
      ? ai.escapeSide >= 0
      : leftRoom > rightRoom;
    ai.escapeSide = preferLeft ? 1 : -1;
    ai.escapeDir.copy(preferLeft ? left : right);
    // lean a little away from whatever we were pushing into, so we peel off the surface
    ai.escapeDir.addScaledVector(wishDir, -0.35).normalize();
    ai.escapeTimer = 0.55 + Math.random() * 0.45;

    // a hop clears kerbs and props that a sidestep alone won't
    if (ai.grounded && Math.random() < 0.5) {
      entity.velocity.y = JUMP_SPEED;
      ai.grounded = false;
    }
  }

  function shoot(dt, entities) {
    ai.fireCooldown -= dt;
    ai.burstCooldown -= dt;
    ai.reaction = Math.max(0, ai.reaction - dt);

    if (!ai.target || !ai.target.alive || ai.reaction > 0 || entity.ammo <= 0) return;
    eyePosition(entity, eye);
    eyePosition(ai.target, targetEye);
    if (!collision.lineOfSight(eye, targetEye)) return;

    if (ai.burst <= 0) {
      if (ai.burstCooldown > 0) return;
      ai.burst = burstSize;
      ai.burstCooldown = 0.55 + Math.random() * 0.8;
      // each spray drifts to its own side, like a hand correcting late
      ai.burstBias.set(Math.random() - 0.5, (Math.random() - 0.5) * 0.6, Math.random() - 0.5)
        .multiplyScalar(accuracy * 2.2);
    }
    if (ai.fireCooldown > 0) return;

    ai.fireCooldown = 0.11 + Math.random() * 0.03;
    ai.burst--;
    entity.ammo--;
    character.triggerFire();
    character.muzzle.getWorldPosition(muzzleWorld);

    // Aim center-mass, at where the target was a beat ago so strafing dodges bullets.
    // Once the body-shot budget is full the bot goes for the head instead, and keeps
    // going for it until one lands — which is what makes the cadence exact rather than
    // roughly-every-so-often. Hard has no budget and never comes through here.
    const leashed = rules.headshotEvery > 0;
    const huntingHead = leashed && ai.bodyHits >= rules.headshotEvery;

    aimPoint.copy(ai.target.position)
      .setY(ai.target.position.y + (huntingHead ? HEAD_HEIGHT : CENTER_MASS))
      .addScaledVector(ai.targetVel, -trackLag);
    toTarget.subVectors(aimPoint, eye).normalize().add(ai.burstBias).normalize();

    // unsettled aim, a moving target, own movement and spray length all widen the cone
    const settle = THREE.MathUtils.clamp(ai.settle / settleTime, 0, 1);
    const selfSpeed = Math.hypot(entity.velocity.x, entity.velocity.z);
    const sprayIndex = burstSize - ai.burst;
    let spread = accuracy * (1 + (1 - settle) * 2.8)
      + ai.targetVel.length() * 0.0035
      + selfSpeed * 0.0022
      + sprayIndex * 0.003;
    if (!ai.grounded) spread += 0.03;
    if (huntingHead) spread *= HEAD_AIM_SPREAD;

    // An easy bot throws a share of its shots away on purpose. A sideways nudge rather
    // than more spread, so the tracer visibly sails past you instead of the bot just
    // looking like it can't shoot straight.
    if (rules.extraMiss > 0 && Math.random() < rules.extraMiss) {
      wideAxis.set(-toTarget.z, 0, toTarget.x).normalize();
      const swing = (0.08 + Math.random() * 0.08) * (Math.random() < 0.5 ? -1 : 1);
      toTarget.addScaledVector(wideAxis, swing).normalize();
    }

    const result = combat.fire({
      origin: eye,
      direction: toTarget,
      shooter: entity,
      entities,
      spread,
      damage: 17,
      muzzle: muzzleWorld,
      allowHeadshot: !leashed || huntingHead,
    });
    if (result) {
      // The budget counts only what landed, so a bot that can't hit anything never earns a
      // headshot either — and it stops counting once the hunt is on. A head is a far
      // smaller target than a chest, so a hunt takes a few shots to connect; letting those
      // body hits keep counting would push the real cadence to twice the stated one.
      if (result.headshot) ai.bodyHits = 0;
      else if (!huntingHead) ai.bodyHits++;

      result.victim.takeDamage?.(result.damage, entity);
      if (!result.victim.alive) {
        entity.kills++;
        entity.onKill?.(result.victim, result.headshot);
      }
    }
  }

  function update(dt, entities) {
    if (!entity.alive) {
      entity.respawnTimer -= dt;
      return;
    }

    ai.clock += dt;

    // watch the target like a player would: velocity estimate + settling aim
    if (ai.target && ai.target.alive) {
      if (ai.hasTargetHistory) {
        tmp.subVectors(ai.target.position, ai.lastTargetPos).divideScalar(Math.max(dt, 1e-4));
        ai.targetVel.lerp(tmp, Math.min(1, dt * 8));
      } else {
        ai.targetVel.set(0, 0, 0);
      }
      ai.lastTargetPos.copy(ai.target.position);
      ai.hasTargetHistory = true;

      eyePosition(entity, eye);
      eyePosition(ai.target, targetEye);
      if (collision.lineOfSight(eye, targetEye)) ai.settle += dt;
      else ai.settle = Math.max(0, ai.settle - dt * 2);
    } else {
      ai.settle = 0;
      ai.hasTargetHistory = false;
      ai.targetVel.set(0, 0, 0);
    }

    think(dt, entities);
    steer(dt);
    detectStuck(dt);
    shoot(dt, entities);

    // physics — target speed scales with intent, so movement eases in and out
    const intent = Math.min(1, wishDir.length());
    const moving = intent > 0.05;
    if (ai.grounded) {
      const speed = Math.hypot(entity.velocity.x, entity.velocity.z);
      if (speed > 0.01) {
        const drop = Math.max(speed, 4) * FRICTION * dt;
        const scale = Math.max(0, speed - drop) / speed;
        entity.velocity.x *= scale;
        entity.velocity.z *= scale;
      }
      if (moving) {
        tmp.copy(wishDir).normalize();
        const goal = maxSpeed * intent;
        const current = entity.velocity.x * tmp.x + entity.velocity.z * tmp.z;
        const add = Math.min(ACCEL * goal * dt, Math.max(0, goal - current));
        entity.velocity.x += tmp.x * add;
        entity.velocity.z += tmp.z * add;
      }
    } else {
      if (moving) {
        tmp.copy(wishDir).normalize();
        const current = entity.velocity.x * tmp.x + entity.velocity.z * tmp.z;
        const add = Math.min(60 * 1.3 * dt, Math.max(0, 1.3 - current));
        entity.velocity.x += tmp.x * add;
        entity.velocity.z += tmp.z * add;
      }
    }

    // always fall — see the note in player.js: a controller given no downward movement
    // reports airborne, and the grounded flag flickers every frame
    entity.velocity.y -= GRAVITY * dt;

    // Rapier sweeps the capsule against the map's triangles — autostep takes the kerbs
    ai.grounded = collision.moveCapsule(
      entity, entity.position, 0.42, 1.8,
      entity.velocity.x * dt, entity.velocity.y * dt, entity.velocity.z * dt,
      entity.velocity,        // slide along contacts instead of keeping dead speed
    );
    if (ai.grounded && entity.velocity.y < 0) entity.velocity.y = -GROUND_STICK;
    ai.airTime = ai.grounded ? 0 : ai.airTime + dt;

    const floor = collision.groundAt(entity.position.x, entity.position.z);
    if (entity.position.y < floor - 2) {          // fell through the world
      entity.position.y = floor;
      entity.velocity.y = 0;
      ai.grounded = true;
    }

    // facing: turn rate is capped, so snaps become sweeps
    let desiredYaw = ai.yaw;
    if (ai.target && ai.target.alive) {
      toTarget.subVectors(ai.target.position, entity.position);
      desiredYaw = Math.atan2(-toTarget.x, -toTarget.z);
      ai.pitch = Math.atan2(
        (ai.target.position.y + 1.6) - (entity.position.y + 1.6),
        Math.hypot(toTarget.x, toTarget.z)
      );
    } else if (entity.velocity.lengthSq() > 0.5) {
      desiredYaw = Math.atan2(-entity.velocity.x, -entity.velocity.z);
      ai.pitch *= 0.9;
    } else if (ai.pauseTimer > 0) {
      // idle glance while lingering at a waypoint
      desiredYaw = ai.yaw + Math.sin(ai.clock * 0.8) * 0.5 * dt * 10;
      ai.pitch *= 0.95;
    }
    let delta = ((desiredYaw - ai.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (delta < -Math.PI) delta += Math.PI * 2;
    const cap = (ai.target ? turnRate : 3.5) * dt;
    ai.yaw += THREE.MathUtils.clamp(delta * Math.min(1, dt * 10), -cap, cap);

    // animation
    const speed = Math.hypot(entity.velocity.x, entity.velocity.z);
    const fwd = tmp.set(-Math.sin(ai.yaw), 0, -Math.cos(ai.yaw));
    const forwardAmount = entity.velocity.x * fwd.x + entity.velocity.z * fwd.z;
    const strafeAmount = entity.velocity.x * Math.cos(ai.yaw) + entity.velocity.z * -Math.sin(ai.yaw);

    character.root.position.copy(entity.position);
    character.root.rotation.y = ai.yaw;
    character.poseFromMotion({
      speed,
      forward: forwardAmount,
      strafe: strafeAmount,
      grounded: ai.airTime < 0.12,     // coyote time, same as the player
      crouching: false,
    });
    character.update(dt, { aimPitch: ai.pitch, moveSpeed: speed });
  }

  entity.spawn = spawn;
  entity.update = update;
  entity.ai = ai;
  return entity;
}
