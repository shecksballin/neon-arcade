import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { stylize } from './world.js';

// Absolute path: the arcade serves the shared asset pack from the web root, while the
// game itself lives one level down at /neon-pug-shooter/.
const DIR = '/neonpugshootercomponents/';

// state name -> source file. The rig is one Mixamo skeleton, so every clip retargets for free.
const CLIP_FILES = {
  idle:        'Rifle Aiming Idle.fbx',
  fire:        'Firing Rifle.fbx',
  run:         'Walk Forward.fbx',
  strafeLeft:  'StrafeLeft.fbx',
  strafeRight: 'StrafeRight.fbx',
  jump:        'Rifle Jump.fbx',
  crouchIdle:  'Crouch Idle.fbx',
  crouchFwd:   'Walk Crouching Forward.fbx',
  crouchBack:  'Walk Crouching Backward.fbx',
  crouchLeft:  'Walk Crouching Forward Left.fbx',
  crouchRight: 'Walk Crouching Right.fbx',
  reloadIdle:   'idleReload.fbx',
  reloadWalk:   'walkingReload.fbx',
  reloadCrouch: 'crouchReload.fbx',
};

// Full-body clips that play once and hold their last frame, retimed to the reload's length
const RELOAD_STATES = new Set(['reloadIdle', 'reloadWalk', 'reloadCrouch']);

const CHARACTER_HEIGHT = 1.8;
const GUN_LENGTH = 0.85;                        // meters, muzzle to stock
const GUN_OFFSET = { x: 0, y: 4, z: 0 };        // hand-bone space, centimeters
// Meters, in aim space now that the mount is aim-aligned: y is up, z runs down the barrel.
// Drops the grip into the palm and pushes the muzzle forward of the fist.
const GUN_LOCAL = { x: 0, y: -0.06, z: 0.12 };

// FBXLoader strips the colon from Mixamo names, so "mixamorig:RightHand" arrives as
// "mixamorigRightHand". Match on the suffix and both spellings work.
function findBone(model, suffix) {
  let found = null;
  model.traverse((o) => {
    if (found || !o.isBone) return;
    if (o.name === `mixamorig:${suffix}` || o.name === `mixamorig${suffix}` || o.name === suffix) found = o;
  });
  return found;
}

let assets = null;

export async function loadCharacterAssets(onProgress = () => {}) {
  if (assets) return assets;

  // The Mixamo FBXs point at a skin texture that didn't ship with them. We re-material
  // everything into toon shading anyway, so swallow those requests instead of 404ing.
  //
  // The stand-in must be a *decoded* image, not a data: URI: an image decode never
  // completes while the tab is backgrounded, which used to hang the loader mid-parse.
  // Seeding three's cache makes ImageLoader hand it back without touching the decoder.
  const WHITE_PIXEL = 'threejs:blank-skin';
  const blank = document.createElement('canvas');
  blank.width = blank.height = 1;
  const blankCtx = blank.getContext('2d');
  blankCtx.fillStyle = '#ffffff';
  blankCtx.fillRect(0, 0, 1, 1);
  THREE.Cache.enabled = true;
  THREE.Cache.add(WHITE_PIXEL, blank);

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => (/\.(fbx|glb|gltf|bin)$/i.test(url) ? url : WHITE_PIXEL));

  const fbxLoader = new FBXLoader(manager);
  const entries = Object.entries(CLIP_FILES);
  let done = 0;

  const loaded = await Promise.all(entries.map(async ([state, file]) => {
    const group = await fbxLoader.loadAsync(DIR + file);
    done++;
    onProgress('loading animations', done / (entries.length + 1));
    return { state, group };
  }));

  // the cache above would otherwise hold ~40MB of FBX buffers for the whole session
  for (const [, file] of entries) THREE.Cache.remove(DIR + file);

  const gun = await new GLTFLoader().loadAsync(DIR + 'gun.glb');

  // the pug's own atlas — loaded on a clean loader so the URL modifier above doesn't eat it
  const skin = await new THREE.TextureLoader().loadAsync(DIR + 'shaded.png');
  skin.colorSpace = THREE.SRGBColorSpace;
  skin.flipY = true;               // FBX uvs are bottom-up — flipping puts the face on the head
  skin.anisotropy = 4;
  skin.needsUpdate = true;

  // the gun's atlas. It came in as a glTF, whose uvs are top-down — the opposite of the FBX.
  const gunSkin = await new THREE.TextureLoader().loadAsync(DIR + 'gunshader.png');
  gunSkin.colorSpace = THREE.SRGBColorSpace;
  gunSkin.flipY = false;
  gunSkin.anisotropy = 4;
  gunSkin.needsUpdate = true;

  onProgress('loading animations', 1);

  // the rig+mesh come from the aiming idle; the rest contribute only their clip
  const source = loaded.find((l) => l.state === 'idle').group;

  const clips = {};
  for (const { state, group } of loaded) {
    const clip = group.animations[0];
    if (!clip) continue;
    // In-place locomotion: drop the clip's horizontal travel, because our physics owns
    // where the body goes. The hips' *vertical* channel has to stay — it's what lowers a
    // crouch onto the ground; without it the legs bend but the pelvis stays standing-tall
    // and the feet sink through the floor. The jump clip is the exception: there the arc
    // would fight our own gravity, so that one loses the track entirely.
    clip.tracks = clip.tracks.flatMap((track) => {
      if (!/Hips\.position$/.test(track.name)) return [track];
      if (state === 'jump') return [];
      const values = Float32Array.from(track.values);
      for (let i = 0; i < values.length; i += 3) {
        values[i] = 0;         // x
        values[i + 2] = 0;     // z
      }
      return [new THREE.VectorKeyframeTrack(track.name, Array.from(track.times), Array.from(values))];
    });
    clip.name = state;
    clips[state] = clip;
  }

  // firing layers on top of whatever the legs are doing
  if (clips.fire && clips.idle) {
    const additive = clips.fire.clone();
    additive.name = 'fireAdditive';
    THREE.AnimationUtils.makeClipAdditive(additive, 0, clips.idle, 30);
    clips.fireAdditive = additive;
  }

  // normalize height: Mixamo exports in centimeters
  const bounds = new THREE.Box3().setFromObject(source);
  const scale = CHARACTER_HEIGHT / Math.max(0.001, bounds.max.y - bounds.min.y);

  assets = { source, clips, gunSource: gun.scene, scale, skin, gunSkin };
  return assets;
}

export function createCharacter({ tint = '#ffffff', gunTint = '#ffffff', teamGlow = null } = {}) {
  const { source, clips, gunSource, scale, skin, gunSkin } = assets;

  const model = cloneSkinned(source);
  model.scale.setScalar(scale);
  model.rotation.y = Math.PI;          // Mixamo faces +Z; the game's forward is -Z
  model.traverse((child) => {
    if (child.isMesh || child.isSkinnedMesh) {
      // shaded.png is the pug atlas. The outfit is near-black, so a multiplied tint can't
      // carry team colour — a low emissive does, without washing the texture out.
      stylize(child, { tint, map: skin, emissive: teamGlow, emissiveIntensity: teamGlow ? 0.13 : 1 });
      child.frustumCulled = false;     // skinned bounds go stale when animating
    }
  });

  const root = new THREE.Group();
  root.add(model);

  // gun in the right hand
  const gun = gunSource.clone(true);
  gun.traverse((child) => { if (child.isMesh) stylize(child, { tint: gunTint, map: gunSkin }); });
  const gunBox = new THREE.Box3().setFromObject(gun);
  const gunLength = Math.max(gunBox.max.z - gunBox.min.z, gunBox.max.x - gunBox.min.x);
  gun.scale.setScalar(GUN_LENGTH / Math.max(0.001, gunLength));
  gun.position.set(GUN_LOCAL.x, GUN_LOCAL.y, GUN_LOCAL.z);

  const hand = findBone(model, 'RightHand');
  const gunMount = new THREE.Group();
  gunMount.add(gun);
  // bone space is centimeters; undoing the character scale puts the gun back in meters
  gunMount.scale.setScalar(1 / scale);
  gunMount.position.set(GUN_OFFSET.x, GUN_OFFSET.y, GUN_OFFSET.z);
  if (hand) hand.add(gunMount);
  else console.warn('right hand bone not found — gun unattached');

  // muzzle marker, used as the tracer origin (gun-local units, before its own scale)
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.45, 0.95);
  gun.add(muzzle);

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const [name, clip] of Object.entries(clips)) {
    const action = mixer.clipAction(clip);
    if (name === 'fireAdditive') {
      action.blendMode = THREE.AdditiveAnimationBlendMode;
      action.setLoop(THREE.LoopRepeat);
      action.weight = 0;
      action.play();
    } else if (name === 'jump' || RELOAD_STATES.has(name)) {
      action.setLoop(THREE.LoopOnce);
      action.clampWhenFinished = true;
    }
    actions[name] = action;
  }

  let current = null;
  let fireWeight = 0;
  let runReversed = false;      // walking backwards plays the run clip in reverse

  function setState(name, fade = 0.16) {
    if (name === current || !actions[name]) return;
    const next = actions[name];
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (current && actions[current]) actions[current].fadeOut(fade);
    current = name;
  }

  // Swapping reload clips mid-reload (you start walking halfway through) hands the new
  // clip the old one's progress, so the mag doesn't jump back into the gun.
  function setReloadState(name) {
    if (name === current || !actions[name]) return;
    const prev = actions[current];
    const at = RELOAD_STATES.has(current) && prev
      ? prev.time / Math.max(1e-4, prev.getClip().duration)
      : 0;
    setState(name, 0.12);
    if (at > 0) actions[name].time = at * actions[name].getClip().duration;
  }

  const spine = findBone(model, 'Spine1') || findBone(model, 'Spine');
  const chest = findBone(model, 'Spine2');
  const neck = findBone(model, 'Neck');
  const head = findBone(model, 'Head');

  // Point the barrel exactly where the character is aiming. The clip's arm animation still
  // carries the gun (its position comes from the hand bone), but the orientation is solved
  // each frame, so the muzzle lines up with the crosshair instead of drifting with the pose.
  const _handQuat = new THREE.Quaternion();
  const _aimQuat = new THREE.Quaternion();
  const _aimDir = new THREE.Vector3();
  const _aimMatrix = new THREE.Matrix4();
  const _origin = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);

  function aimGun(pitch) {
    if (!hand) return;
    root.updateMatrixWorld(true);

    const yaw = root.rotation.y;
    const cp = Math.cos(pitch);
    _aimDir.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);

    // for meshes, three's lookAt convention puts +Z on the target — which is the barrel
    _aimMatrix.lookAt(_aimDir, _origin.set(0, 0, 0), _up);
    _aimQuat.setFromRotationMatrix(_aimMatrix);

    hand.getWorldQuaternion(_handQuat);
    gunMount.quaternion.copy(_handQuat.invert()).multiply(_aimQuat);
  }

  const api = {
    root,
    model,
    muzzle,
    gun,
    gunMount,
    mixer,
    actions,
    height: CHARACTER_HEIGHT,

    setState,

    triggerFire() {
      fireWeight = 1;
      if (actions.fireAdditive && !actions.fireAdditive.isRunning()) actions.fireAdditive.play();
    },

    // Stretch or squeeze the reload clips so the animation runs exactly as long as the
    // reload itself, which is the sound effect's own length.
    setReloadDuration(seconds) {
      if (!(seconds > 0)) return;
      for (const name of RELOAD_STATES) {
        const action = actions[name];
        if (action) action.timeScale = action.getClip().duration / seconds;
      }
    },

    // pick the clip that matches how the body is actually moving
    poseFromMotion({ speed, forward, strafe, grounded, crouching, reloading = false }) {
      if (reloading) {
        // A reload mid-bunny-hop borrows the standing clip — there's no airborne one, and
        // the legs are tucked either way. Crouch-walking has no reload animation at all,
        // so you have to plant your feet if you want to see the mag go in while crouched.
        if (!grounded) return setReloadState('reloadIdle');
        if (crouching) return speed < 0.4 ? setReloadState('reloadCrouch') : undefined;
        return setReloadState(speed < 0.5 ? 'reloadIdle' : 'reloadWalk');
      }
      if (!grounded) return setState('jump', 0.1);
      if (crouching) {
        if (speed < 0.4) return setState('crouchIdle');
        if (Math.abs(strafe) > Math.abs(forward)) return setState(strafe > 0 ? 'crouchRight' : 'crouchLeft');
        return setState(forward < 0 ? 'crouchBack' : 'crouchFwd');
      }
      if (speed < 0.5) return setState('idle');
      if (Math.abs(strafe) > Math.abs(forward) * 1.2) return setState(strafe > 0 ? 'strafeRight' : 'strafeLeft');
      // no standing back-walk in the Mixamo set, so run the forward one in reverse
      runReversed = forward < 0;
      return setState('run');
    },

    update(dt, { aimPitch = 0, moveSpeed = 0 } = {}) {
      if (actions.run) {
        const rate = THREE.MathUtils.clamp(moveSpeed / 4.2, 0.7, 2.2);
        actions.run.timeScale = runReversed ? -rate : rate;
      }
      mixer.update(dt);

      fireWeight = Math.max(0, fireWeight - dt * 4.5);
      if (actions.fireAdditive) actions.fireAdditive.weight = fireWeight;

      // lean the whole upper body into the aim, so the pug reads as looking down the sights
      const pitch = THREE.MathUtils.clamp(aimPitch, -1.0, 1.0);
      if (spine) spine.rotation.x += pitch * 0.8;
      if (chest) chest.rotation.x += pitch * 0.25;
      if (neck) neck.rotation.x += pitch * 0.3;
      if (head) head.rotation.x += pitch * 0.45;

      aimGun(pitch);
    },

    eyePosition(out = new THREE.Vector3()) {
      if (head) return head.getWorldPosition(out);
      return out.copy(root.position).setY(root.position.y + 1.6);
    },

    dispose() {
      mixer.stopAllAction();
      root.parent?.remove(root);
    },
  };

  setState('idle', 0);
  mixer.update(0.001);        // settle into the aiming pose before placing the gun
  aimGun(0);
  return api;
}
