import { useGLTF } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';

/**
 * The neon stadium. Converted from the shipped 16MB FBX to a texture-compressed
 * GLB by tools/convert_assets.py — identical geometry, a fraction of the parse cost.
 *
 * Placement anchors on the green playing surface: the model's own extents include
 * terrain and stands that say nothing about where the pitch is, so the "Field"
 * mesh is scaled to a 105m goal-to-goal length and centred half a pitch downfield
 * of our goal line at z=0.
 */
const PITCH_LENGTH = 105;
const FIELD_CENTRE_Z = 52.5;

/**
 * Ground dressing we drop on the floor.
 *
 * The model is an athletics stadium, so what it paints on the grass is running-
 * track lanes, not pitch markings, and it rings the goalmouth with advertising
 * hoardings. Both crowd the one thing the striker needs to read. We hide them and
 * draw regulation outlines ourselves in PitchLines — leaving the field with the
 * goal and its markings and nothing else. The stands, roof and glow lines stay.
 */
const HIDDEN_MATERIALS = new Set(['Field Markup', 'Back Banners', 'Field Banners']);

/**
 * Everything past here is cut away.
 *
 * The model keeps its own football pitch inset inside the athletics track, and
 * its near goal — net, frame and surround — sits at z 20 to 28, directly behind
 * the striker. It cannot be hidden by material: the whole structure, stands and
 * roof included, is merged into one 331k-vertex "Metal Black" mesh, so there is
 * nothing to switch off on its own.
 *
 * A clipping plane cuts by position instead of by object, which is the only
 * handle that reaches inside a merged mesh. Fog cannot do it either — the
 * geometry in question is a couple of metres from the striker's camera, nearer
 * than the goal it is meant to sit behind.
 */
const CLIP_BEHIND_Z = 18;

/**
 * The model's grass is a single 121m slab. In a third-person view that slab runs
 * away behind the striker for the length of the pitch, and with the fog pulled
 * in it reads as a grey shelf hanging in the dark. Ours is a fitted plane around
 * the penalty area instead, so there is simply nothing back there.
 */
const HIDE_TURF = true;

function findByMaterial(root: THREE.Object3D, materialName: string): THREE.Mesh | null {
  let hit: THREE.Mesh | null = null;
  root.traverse((obj) => {
    if (hit || !(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    if (mats.some((m) => (m as THREE.Material)?.name === materialName)) hit = obj;
  });
  return hit;
}

export function Stadium() {
  const { scene } = useGLTF('/neon-kickoff/stadium.glb');

  // keeps the half-space z < CLIP_BEHIND_Z, which is everything from the goal
  // out to just behind the striker
  const clip = useMemo(() => [new THREE.Plane(new THREE.Vector3(0, 0, -1), CLIP_BEHIND_Z)], []);

  const root = useMemo(() => {
    const model = scene;
    // useGLTF hands back a cached scene, so start from a clean transform —
    // otherwise every hot reload compounds the last placement onto this one
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    model.scale.setScalar(1);

    const field = findByMaterial(model, 'Field') ?? model;
    const measure = () => {
      model.updateMatrixWorld(true);
      return new THREE.Box3().setFromObject(field);
    };

    let box = measure();
    let size = box.getSize(new THREE.Vector3());

    // the long axis of the pitch has to run along z, goal to goal
    if (size.x > size.z) {
      model.rotation.y = Math.PI / 2;
      box = measure();
      size = box.getSize(new THREE.Vector3());
    }

    model.scale.setScalar(PITCH_LENGTH / Math.max(size.z, 1e-3));
    box = measure();

    const centre = box.getCenter(new THREE.Vector3());
    model.position.x -= centre.x;
    model.position.z += FIELD_CENTRE_Z - centre.z;
    model.position.y -= box.max.y + 0.01; // grass just under our y=0

    model.traverse((obj) => {
      // `.isMesh` + a cast rather than instanceof: the arcade's three types
      // (0.184) don't narrow Object3D through instanceof in this position.
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      mesh.receiveShadow = true;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (mats.some((m) => HIDDEN_MATERIALS.has((m as THREE.Material)?.name))) {
        obj.visible = false;
        return;
      }
      if (HIDE_TURF && mats.some((m) => (m as THREE.Material)?.name === 'Field')) {
        obj.visible = false;
        return;
      }
      for (const mat of mats) {
        const m = mat as THREE.MeshStandardMaterial;
        const name = (m.name || '').toLowerCase();
        m.clippingPlanes = clip;
        m.clipShadows = true;
        if (m.emissiveMap) {
          m.emissive = new THREE.Color('#ffffff');
          m.emissiveIntensity = name.includes('glowlines') ? 3.4 : 1.7;
        }
        if (name.includes('glass')) {
          m.transparent = true;
          m.opacity = Math.min(m.opacity, 0.22);
          m.depthWrite = false;
          m.side = THREE.DoubleSide;
        }
        if (name.includes('field') && !name.includes('banner')) {
          m.roughness = 0.85;
          m.metalness = 0;
        }
      }
    });

    if (import.meta.env.DEV) {
      const final = measure();
      (window as unknown as { __stadium: unknown }).__stadium = {
        fieldSize: final.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(1)),
        centre: final.getCenter(new THREE.Vector3()).toArray().map((v) => +v.toFixed(1)),
        scale: +model.scale.x.toFixed(3),
      };
    }
    return model;
  }, [scene, clip]);

  return <primitive object={root} />;
}

useGLTF.preload('/neon-kickoff/stadium.glb');
