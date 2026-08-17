// Character loading + per-pawn instances + animation state machine.
// Mesh/skeleton come from assets/models/mummy.glb (9 clips merged from the
// user's Mixamo FBX set); PBR maps are the user's PNGs applied in code.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { CFG } from "./config.js";

export const CLIPS = ["Idle", "Walk", "Sprint", "SprintTurnR", "SprintTurnL",
                      "Jump", "Fall", "Trip", "GetUp"];

// Clips whose baked hips Y motion must be stripped (physics owns height).
const STRIP_Y = new Set(["Jump", "Fall"]);

function stripRootMotion(clip) {
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".position") || !track.name.includes("Hips")) continue;
    const v = track.values;
    const x0 = v[0], y0 = v[1], z0 = v[2];
    const stripY = STRIP_Y.has(clip.name);
    for (let i = 0; i < v.length; i += 3) {
      v[i] = x0;                       // no horizontal drift - controller moves the pawn
      if (stripY) v[i + 1] = y0;
      v[i + 2] = z0;
    }
  }
  return clip;
}

export async function loadCharacterTemplate(onProgress) {
  const texLoader = new THREE.TextureLoader();
  const tex = (url, srgb) => new Promise((res, rej) => {
    texLoader.load(url, (t) => {
      t.flipY = false;                 // glTF UV convention
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      res(t);
    }, undefined, rej);
  });

  const gltfP = new Promise((res, rej) => {
    new GLTFLoader().load("./assets/models/mummy.glb", res,
      (e) => onProgress && e.total && onProgress(e.loaded / e.total), rej);
  });

  const [gltf, map, normalMap, roughnessMap, metalnessMap] = await Promise.all([
    gltfP,
    tex("./assets/textures/mummy_diffuse.png", true),
    tex("./assets/textures/mummy_normal.png", false),
    tex("./assets/textures/mummy_roughness.png", false),
    tex("./assets/textures/mummy_metallic.png", false),
  ]);

  const root = gltf.scene;

  // Normalize model height to CFG.charHeight and lift so feet sit exactly at
  // the group origin (the controller positions pawns by their feet).
  const bbox = new THREE.Box3().setFromObject(root);
  const rawH = Math.max(0.001, bbox.max.y - bbox.min.y);
  const scale = CFG.charHeight / rawH;
  root.scale.setScalar(scale);
  root.position.y = -bbox.min.y * scale;

  const material = new THREE.MeshStandardMaterial({
    map, normalMap, roughnessMap, metalnessMap,
    metalness: 1.0, roughness: 1.0,
    side: THREE.DoubleSide,
  });

  root.traverse((o) => {
    if (o.isSkinnedMesh) {
      o.material = material;
      o.castShadow = true;
      o.receiveShadow = false;
      o.frustumCulled = false;         // skinned bounds lag the ragdoll flops
    }
  });

  const clips = new Map();
  for (const c of gltf.animations) clips.set(c.name, stripRootMotion(c));
  for (const name of CLIPS) {
    if (!clips.has(name)) console.warn("missing clip:", name);
  }

  return { root, clips, material, scale };
}

let nameTagCanvas = null;
function makeNameTag(text, color) {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 64;
  const g = cv.getContext("2d");
  g.font = "900 34px system-ui, sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = color; g.shadowBlur = 14;
  g.fillStyle = "#ffffff";
  g.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(1.5, 0.375, 1);
  return sp;
}

const FADE = 0.16;

export class Character {
  constructor(template, { tint = null, name = null, tagColor = "#00FFD1", isPlayer = false } = {}) {
    this.group = new THREE.Group();
    const inner = SkeletonUtils.clone(template.root);
    this.group.add(inner);
    this.group.traverse((o) => {
      if (o.isSkinnedMesh) {
        o.material = template.material.clone();
        if (tint) o.material.color.set(tint);
        o.castShadow = true;
      }
    });

    this.mixer = new THREE.AnimationMixer(this.group);
    this.actions = {};
    for (const [n, clip] of template.clips) {
      const a = this.mixer.clipAction(clip);
      a.enabled = false;
      this.actions[n] = a;
    }
    this.current = null;
    this.oneShot = null;             // { name, onDone }
    this.mixer.addEventListener("finished", (e) => {
      if (this.oneShot && e.action === this.actions[this.oneShot.name]) {
        const done = this.oneShot;
        this.oneShot = null;
        if (done.onDone) done.onDone();
      }
    });

    // Bones lookup for ragdoll + markers. GLTFLoader sanitizes node names
    // ("mixamorig:Hips" -> "mixamorigHips"), so index by the short suffix.
    this.bones = {};
    this.group.traverse((o) => {
      if (o.isBone) this.bones[o.name.replace(/^mixamorig:?/, "")] = o;
    });

    this.nameTag = null;
    if (name && !isPlayer) {
      this.nameTag = makeNameTag(name, tagColor);
      this.group.add(this.nameTag);
      this.nameTag.position.set(0, CFG.charHeight + 0.42, 0);
    }
    if (isPlayer) {
      // #00FFD1 marker cone above the player, like the reference footage
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.09, 0.2, 4),
        new THREE.MeshBasicMaterial({ color: CFG.rimColor, toneMapped: false }));
      cone.rotation.x = Math.PI;
      cone.position.set(0, CFG.charHeight + 0.36, 0);
      this.marker = cone;
      this.group.add(cone);
    }
  }

  playLoop(name, fade = FADE, timeScale = 1) {
    if (this.oneShot) return;          // one-shots own the rig until done
    this._to(name, fade, timeScale, THREE.LoopRepeat);
  }

  playOnce(name, { timeScale = 1, fade = FADE, holdLast = true, onDone = null } = {}) {
    this._to(name, fade, timeScale, THREE.LoopOnce, holdLast);
    this.oneShot = { name, onDone };
  }

  cancelOneShot() { this.oneShot = null; }

  _to(name, fade, timeScale, loop, holdLast = false) {
    if (this.current === name && loop === THREE.LoopRepeat) {
      const cur = this.actions[name];   // keep foot speed matched to velocity
      if (cur && Math.abs(cur.timeScale - timeScale) > 0.01) cur.timeScale = timeScale;
      return;
    }
    const next = this.actions[name];
    if (!next) return;
    next.enabled = true;
    next.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
    next.clampWhenFinished = holdLast;
    next.timeScale = timeScale;
    next.reset().fadeIn(fade).play();
    if (this.current && this.current !== name) {
      const prev = this.actions[this.current];
      if (prev) prev.fadeOut(fade);
    }
    this.current = name;
  }

  stopAll() {
    this.mixer.stopAllAction();
    for (const a of Object.values(this.actions)) a.enabled = false;
    this.current = null;
    this.oneShot = null;
  }

  update(dt) {
    this.mixer.update(dt);
    if (this.marker) this.marker.rotation.y += dt * 2.4;
  }

  oneShotProgress() {
    if (!this.oneShot) return 1;
    const a = this.actions[this.oneShot.name];
    if (!a) return 1;
    return a.time / a.getClip().duration;
  }
}
