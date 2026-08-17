// Rapier-powered ragdolls: 11 capsule bodies mapped onto the Mixamo skeleton,
// spherical joints at the anatomical connections. While a ragdoll is live the
// animation mixer is stopped and the bones are driven from the physics bodies
// (hips get position+rotation, the rest rotation only).
import * as THREE from "three";
import { CFG } from "./config.js";

// part list: index order matters (parents before children for bone driving)
const PARTS = [
  { bone: "Hips",         to: "Spine2",      r: 0.15, root: true },
  { bone: "Spine2",       to: "Head",        r: 0.13 },
  { bone: "Head",         to: "HeadTop_End", r: 0.125 },
  { bone: "LeftArm",      to: "LeftForeArm", r: 0.062 },
  { bone: "LeftForeArm",  to: "LeftHand",    r: 0.052 },
  { bone: "RightArm",     to: "RightForeArm",r: 0.062 },
  { bone: "RightForeArm", to: "RightHand",   r: 0.052 },
  { bone: "LeftUpLeg",    to: "LeftLeg",     r: 0.092 },
  { bone: "LeftLeg",      to: "LeftFoot",    r: 0.072 },
  { bone: "RightUpLeg",   to: "RightLeg",    r: 0.092 },
  { bone: "RightLeg",     to: "RightFoot",   r: 0.072 },
];
// child part index -> parent part index (joint at the child bone's origin)
const JOINT_PARENT = { 1: 0, 2: 1, 3: 1, 4: 3, 5: 1, 6: 5, 7: 0, 8: 7, 9: 0, 10: 9 };

const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();

export class RagdollSystem {
  constructor(RAPIER, world) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.list = new Set();
  }

  get activeBodies() { return this.list.size * PARTS.length; }

  spawn(character, velocity, { impulse = null } = {}) {
    if (this.list.size >= CFG.ragMaxConcurrent) {
      const oldest = this.list.values().next().value;
      this.release(oldest);
    }
    character.stopAll();
    character.group.updateWorldMatrix(true, true);

    const rag = { character, entries: [], age: 0, dead: false, lastHips: null };
    const bodiesByPart = [];

    for (const part of PARTS) {
      const bone = character.bones[part.bone];
      const child = character.bones[part.to];
      if (!bone || !child) { bodiesByPart.push(null); continue; }
      bone.getWorldPosition(_v0);
      child.getWorldPosition(_v1);
      const len = Math.max(0.05, _v0.distanceTo(_v1));
      _v2.copy(_v1).sub(_v0).normalize();
      const radius = part.r;
      const halfH = Math.max(0.012, len / 2 - radius * 0.7);
      const mid = _v2.clone().multiplyScalar(len / 2).add(_v0);
      _q0.setFromUnitVectors(_up, _v2);

      const bodyDesc = this.RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(mid.x, mid.y, mid.z)
        .setRotation({ x: _q0.x, y: _q0.y, z: _q0.z, w: _q0.w })
        .setLinvel(velocity.x + (Math.random() - 0.5) * 1.2,
                   velocity.y + (Math.random() - 0.5) * 0.6,
                   velocity.z + (Math.random() - 0.5) * 1.2)
        .setLinearDamping(CFG.ragLinearDamping)
        .setAngularDamping(CFG.ragAngularDamping)
        .setCcdEnabled(part.root === true);
      const body = this.world.createRigidBody(bodyDesc);
      const colDesc = this.RAPIER.ColliderDesc.capsule(halfH, radius)
        .setFriction(0.7).setRestitution(0.3)
        .setCollisionGroups(0x00020001); // member RAG(2), collides with TILE(1)
      this.world.createCollider(colDesc, body);

      // rotation offset: bone world rotation relative to body rotation
      bone.getWorldQuaternion(_q1);
      const qOff = _q0.clone().invert().multiply(_q1);

      bodiesByPart.push(body);
      rag.entries.push({ part, bone, body, qOff, isRoot: part.root === true });
    }

    // joints
    for (const [ci, pi] of Object.entries(JOINT_PARENT)) {
      const childBody = bodiesByPart[ci], parentBody = bodiesByPart[pi];
      if (!childBody || !parentBody) continue;
      const childBone = character.bones[PARTS[ci].bone];
      childBone.getWorldPosition(_v0);              // world anchor
      const a1 = toLocal(parentBody, _v0);
      const a2 = toLocal(childBody, _v0);
      const jd = this.RAPIER.JointData.spherical(a1, a2);
      this.world.createImpulseJoint(jd, parentBody, childBody, true);
    }

    if (impulse) {
      const hips = bodiesByPart[0];
      const chest = bodiesByPart[1];
      if (hips) hips.applyImpulse({ x: impulse.x * 0.7, y: impulse.y * 0.7, z: impulse.z * 0.7 }, true);
      if (chest) chest.applyImpulse({ x: impulse.x * 0.5, y: impulse.y * 0.5, z: impulse.z * 0.5 }, true);
    }

    this.list.add(rag);
    return rag;
  }

  hipsOf(rag) {
    if (rag.dead) return rag.lastHips;   // body freed - serve the cached spot
    const e = rag.entries[0];
    if (!e) return null;
    const t = e.body.translation();
    if (!rag.lastHips) rag.lastHips = { x: 0, y: 0, z: 0 };
    rag.lastHips.x = t.x; rag.lastHips.y = t.y; rag.lastHips.z = t.z;
    return rag.lastHips;
  }

  // called after world.step(): copy body transforms onto bones
  update(dt) {
    for (const rag of this.list) {
      rag.age += dt;
      for (const e of rag.entries) {
        const rot = e.body.rotation();
        _q0.set(rot.x, rot.y, rot.z, rot.w).multiply(e.qOff); // target world quat
        const parent = e.bone.parent;
        parent.getWorldQuaternion(_q1).invert();
        e.bone.quaternion.copy(_q1.multiply(_q0));
        if (e.isRoot) {
          const p = e.body.translation();
          _v0.set(p.x, p.y, p.z);
          _m.copy(parent.matrixWorld).invert();
          e.bone.position.copy(_v0.applyMatrix4(_m));
        }
        e.bone.updateMatrixWorld(false);
      }
    }
  }

  release(rag) {
    if (!this.list.has(rag) || rag.dead) return;
    this.hipsOf(rag);                    // cache final hips position
    rag.dead = true;
    for (const e of rag.entries) this.world.removeRigidBody(e.body);
    this.list.delete(rag);
  }
}

function toLocal(body, worldPos) {
  const t = body.translation(), r = body.rotation();
  _q2.set(r.x, r.y, r.z, r.w).invert();
  const out = new THREE.Vector3(worldPos.x - t.x, worldPos.y - t.y, worldPos.z - t.z)
    .applyQuaternion(_q2);
  return { x: out.x, y: out.y, z: out.z };
}
