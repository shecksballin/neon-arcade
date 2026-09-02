// Pawn: kinematic character controller shared by the player and every bot.
// Movement, gravity and layer landings are custom hex-grid physics (tight,
// Fall-Guys-style control); Rapier owns the ragdoll moments.
import * as THREE from "three";
import { CFG } from "./config.js";

const _dir = new THREE.Vector3();

export const PSTATE = {
  FROZEN: "frozen", GROUND: "ground", AIR: "air", DIVE: "dive",
  TRIP: "trip", GETUP: "getup", RAGDOLL: "ragdoll", DEAD: "dead",
};

export class Pawn {
  constructor(character, level, { name, isPlayer = false } = {}) {
    this.character = character;
    this.level = level;
    this.name = name;
    this.isPlayer = isPlayer;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    // previous-tick transform, captured by game.js at the top of each sim
    // tick; frame() lerps prev -> current so 60Hz sim looks smooth at any hz
    this.prevPos = new THREE.Vector3();
    this.prevYaw = 0;
    this.state = PSTATE.FROZEN;
    this.grounded = false;
    this.layer = CFG.layers - 1;
    this.jumped = false;      // in a jump sequence (space #1 used)
    this.dived = false;       // dive used (space #2)
    this.lockT = 0;           // control lock (trip / getup / dive landing)
    this.immuneT = 0;
    this.alive = true;
    this.stats = { tiles: 0, bumps: 0, time: 0 };
    this._touched = new Set(); // "L:idx" tiles this pawn touched (for stats)
  }

  spawnAt(x, y, z, yaw) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.prevPos.copy(this.pos);   // teleport: never interpolate across a spawn
    this.prevYaw = yaw;
    this.state = PSTATE.FROZEN;
    this.grounded = true;
    this.layer = CFG.layers - 1;
    this.jumped = this.dived = false;
    this.lockT = this.immuneT = 0;
    this.alive = true;
    this.stats = { tiles: 0, bumps: 0, time: 0 };
    this._touched.clear();
    this.character.group.visible = true;
    this.character.group.position.copy(this.pos);
    this.character.group.rotation.y = yaw;
    this.character.cancelOneShot();
    this.character.playLoop("Idle");
  }

  unfreeze() { if (this.state === PSTATE.FROZEN) this.state = PSTATE.GROUND; }

  get locked() {
    return this.state === PSTATE.TRIP || this.state === PSTATE.GETUP ||
           this.state === PSTATE.RAGDOLL || this.state === PSTATE.DEAD ||
           this.state === PSTATE.FROZEN || this.lockT > 0;
  }

  // input: { mx, mz (world dir), sprint, jump, dive, turnDir (-1|0|1), speedMul }
  update(dt, input) {
    if (this.state === PSTATE.RAGDOLL || this.state === PSTATE.DEAD) return;

    if (this.immuneT > 0) this.immuneT -= dt;
    if (this.lockT > 0) this.lockT -= dt;
    if (this.alive && this.state !== PSTATE.FROZEN) this.stats.time += dt;

    const locked = this.locked;
    const mx = locked ? 0 : (input.mx || 0);
    const mz = locked ? 0 : (input.mz || 0);
    const hasMove = (mx !== 0 || mz !== 0);
    const sprint = !locked && !!input.sprint && hasMove;
    const speedMul = input.speedMul || 1;

    // --- horizontal velocity ---
    const targetSpeed = (sprint ? CFG.sprintSpeed : CFG.walkSpeed) * speedMul;
    const ax = this.grounded ? CFG.accel : CFG.accel * CFG.airControl;
    const diveLock = this.state === PSTATE.DIVE;
    if (!diveLock) {
      const tvx = mx * targetSpeed, tvz = mz * targetSpeed;
      const k = Math.min(1, ax * dt / Math.max(0.001, targetSpeed));
      this.vel.x += (tvx - this.vel.x) * (hasMove ? k : Math.min(1, CFG.accel * dt / 3));
      this.vel.z += (tvz - this.vel.z) * (hasMove ? k : Math.min(1, CFG.accel * dt / 3));
    }

    // --- jump / dive ---
    if (!locked && input.jump && this.grounded) {
      this.vel.y = CFG.jumpVel;
      this.grounded = false;
      this.jumped = true;
      this.state = PSTATE.AIR;
      this.character.playOnce("Jump", { timeScale: 1.15, holdLast: true });
      if (this.onJump) this.onJump(this);
    } else if (!locked && input.dive && !this.grounded && this.jumped && !this.dived) {
      this.dived = true;
      this.state = PSTATE.DIVE;
      const fy = this.yaw;
      this.vel.x = Math.sin(fy) * CFG.diveSpeed;
      this.vel.z = Math.cos(fy) * CFG.diveSpeed;
      this.vel.y = CFG.diveUpVel;
      this.character.cancelOneShot();
      this.character.playLoop("Fall", 0.12);
      if (this.onDive) this.onDive(this);
    }

    // --- integrate ---
    const prevY = this.pos.y;
    if (!this.grounded) this.vel.y += CFG.gravity * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;

    // --- ground maintenance / landing ---
    if (this.grounded) {
      const idx = this.level.solidAt(this.layer, this.pos.x, this.pos.z);
      if (idx === -1) {
        this.grounded = false;
        if (this.state === PSTATE.GROUND) {
          this.state = PSTATE.AIR;
          if (!this.character.oneShot) this.character.playLoop("Fall", 0.22);
        }
      } else {
        this.pos.y = this.level.layerTopY(this.layer);
        this.vel.y = 0;
        // countdown freeze must not start eating the spawn tiles
        if (this.state !== PSTATE.FROZEN) this._touch(this.layer, idx);
      }
    }
    if (!this.grounded && this.vel.y <= 0) {
      const L = Math.floor((prevY + 1e-4) / CFG.layerGap);
      if (L >= 0 && L < CFG.layers) {
        const top = this.level.layerTopY(L);
        if (prevY >= top - 1e-3 && this.pos.y <= top) {
          const idx = this.level.solidAt(L, this.pos.x, this.pos.z);
          if (idx !== -1) this._land(L, top, idx);
        }
      }
    }

    // --- facing ---
    if (hasMove && !diveLock) {
      const targetYaw = Math.atan2(mx, mz);
      let d = targetYaw - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * Math.min(1, CFG.turnLerp * dt);
    }

    // --- locomotion animation (one-shots own the rig) ---
    if (!this.character.oneShot && !locked) {
      if (this.grounded) {
        const sp = Math.hypot(this.vel.x, this.vel.z);
        if (sp > CFG.walkSpeed * 1.25) {
          const t = input.turnDir || 0;
          const ts = Math.min(1.5, Math.max(0.9, sp / 6));
          this.character.playLoop(t > 0 ? "SprintTurnR" : t < 0 ? "SprintTurnL" : "Sprint",
                                  undefined, ts);
        } else if (sp > 0.4) {
          this.character.playLoop("Walk", undefined,
                                  Math.min(1.6, Math.max(0.85, sp / 3.2)));
        } else this.character.playLoop("Idle");
      } else if (this.state === PSTATE.DIVE || this.vel.y < -2.5) {
        this.character.playLoop("Fall", 0.2);
      }
    }

    // (no scene write here — frame() interpolates prevPos/prevYaw -> pos/yaw)
  }

  _touch(L, idx) {
    const key = L + ":" + idx;
    if (!this._touched.has(key)) {
      this._touched.add(key);
      this.stats.tiles++;
    }
    this.level.touch(L, idx);
  }

  _land(L, top, idx) {
    this.pos.y = top;
    this.vel.y = 0;
    this.grounded = true;
    this.layer = L;
    const wasDive = this.state === PSTATE.DIVE;
    this.jumped = this.dived = false;
    this.character.cancelOneShot();
    if (wasDive) {
      this.lockT = 0.32;
      this.vel.x *= 0.25; this.vel.z *= 0.25;
    }
    this.state = PSTATE.GROUND;
    this.character.playLoop("Idle", 0.14);
    this._touch(L, idx);
    if (this.onLand) this.onLand(this, wasDive);
  }

  // A sprinting body slammed into us. strong=true -> the caller spawns a
  // Rapier ragdoll instead of the canned trip animation.
  applyBump(impulse, strong) {
    if (!this.alive || this.immuneT > 0) return "immune";
    if (this.state === PSTATE.TRIP || this.state === PSTATE.GETUP ||
        this.state === PSTATE.RAGDOLL) return "busy";
    this.vel.x += impulse.x;
    this.vel.z += impulse.z;
    this.vel.y += impulse.y;
    if (impulse.y > 0.5) this.grounded = false;
    this.immuneT = CFG.tripImmunity;
    if (strong) return "ragdoll";
    this.state = PSTATE.TRIP;
    this.lockT = CFG.tripLockTime;
    this.character.playOnce("Trip", {
      timeScale: 1.3, holdLast: true,
      onDone: () => {
        if (this.state !== PSTATE.TRIP) return;
        this.state = PSTATE.GETUP;
        this.lockT = CFG.getUpLockTime;
        this.character.playOnce("GetUp", {
          timeScale: 1.45,
          onDone: () => {
            if (this.state === PSTATE.GETUP) this.state = PSTATE.GROUND;
          },
        });
      },
    });
    return "trip";
  }

  // Return from a ragdoll (bump recovery): reposition at the ragdoll hips.
  recoverAt(x, y, z) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.character.group.position.copy(this.pos);
    const L = Math.round(y / CFG.layerGap);
    const idx = this.level.solidAt(L, x, z);
    if (idx !== -1 && Math.abs(this.level.layerTopY(L) - y) < 1.0) {
      this.pos.y = this.level.layerTopY(L);
      this.grounded = true;
      this.layer = L;
      this.state = PSTATE.GETUP;
      this.lockT = CFG.getUpLockTime + 0.3;
      this.character.playOnce("GetUp", {
        timeScale: 1.35,
        onDone: () => { if (this.state === PSTATE.GETUP) this.state = PSTATE.GROUND; },
      });
    } else {
      this.grounded = false;
      this.state = PSTATE.AIR;
      this.character.playLoop("Fall", 0.1);
    }
    this.prevPos.copy(this.pos);   // teleport: never interpolate across a recover
    this.prevYaw = this.yaw;
  }

  die() {
    this.alive = false;
    this.state = PSTATE.DEAD;
  }
}
