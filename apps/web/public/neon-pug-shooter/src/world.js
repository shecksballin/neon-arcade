import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createSky } from '../sky.js';
import { createGrass } from '../grass.js';
import { makeCloudTexture, makeFlowTexture } from '../textures.js';
import { MAPS, DEFAULT_MAP } from './maps.js';
import { labelOf } from './collision.js';

// Palette — late evening into early night. Fog color === horizon color still holds
// (design.txt phase 2), the horizon is just dark teal now instead of pale cyan.
export const SKY_COLOR = '#050d1c';      // zenith: near-black navy
export const HORIZON_COLOR = '#0d2b33';  // dark teal dusk remnant + fog
export const CLOUD_COLOR = '#1c3a45';    // night clouds, slate-teal
export const GLOW_COLOR = '#00FFD1';     // neon rim on the horizon
export const SUN_COLOR = '#b8d4ff';      // moonlight

// Indoors there is no sky to light the scene and nothing far away to lose to haze, so the
// horizon palette is replaced by sodium-lamp warmth over near-black, and the fog closes in
// to give a 35m shed some depth instead of reading as a lit box.
export const INTERIOR_FOG = '#070c10';
export const INTERIOR_LAMP = '#ffd9a8';

// Phase 4: one shared 4-step ramp so every surface in the game bands identically.
export const gradientMap = (() => {
  const steps = new Uint8Array([70, 130, 200, 255]);
  const tex = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
})();

// design.txt, "How to make GLBs match the look": shadows on, toon material, keep the source map.
export function stylize(mesh, { tint = null, map = undefined, emissive = null, emissiveIntensity = 1 } = {}) {
  const src = mesh.material;
  const build = (m) => new THREE.MeshToonMaterial({
    // Carry the name across. The collider identifies surfaces by it (see maps.js), and a
    // model whose meaning lives in its materials rather than its object names — the
    // warehouse being exactly that — is invisible to classification without this.
    name: m.name,
    color: tint ? new THREE.Color(tint) : (m.color ? m.color.clone() : new THREE.Color(0xffffff)),
    map: map !== undefined ? map : (m.map || null),
    emissive: emissive ? new THREE.Color(emissive) : new THREE.Color(0x000000),
    emissiveIntensity,
    gradientMap,
    transparent: m.transparent,
    alphaTest: m.alphaTest,
    opacity: m.opacity,
    side: m.side,
  });
  mesh.material = Array.isArray(src) ? src.map(build) : build(src);
  (Array.isArray(src) ? src : [src]).forEach((m) => m.dispose());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
}

const WarmGradeShader = {
  uniforms: {
    tDiffuse:  { value: null },
    uWarmth:   { value: 0.0 },   // night — no afternoon warmth
    uPastel:   { value: 0.06 },
    uVignette: { value: 0.3 },
    uHurt:     { value: 0.0 },   // red flash when the player takes damage
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uWarmth, uPastel, uVignette, uHurt;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 col = tex.rgb;

      col += vec3(uWarmth, uWarmth * 0.45, -uWarmth * 0.3) * col;

      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3(luma), uPastel);

      float d = distance(vUv, vec2(0.5));
      col *= 1.0 - uVignette * smoothstep(0.35, 0.95, d);

      // damage vignette — edges only, so it reads without hiding the fight
      col = mix(col, vec3(0.72, 0.06, 0.09), uHurt * smoothstep(0.45, 1.0, d));

      gl_FragColor = vec4(col, tex.a);
    }
  `,
};

export async function createWorld(onProgress = () => {}, initialMap = DEFAULT_MAP) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;      // phase 1: no ACES, keep it pastel
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;           // static map — bake once
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(HORIZON_COLOR);
  scene.fog = new THREE.Fog(HORIZON_COLOR, 70, 340);   // phase 2

  const camera = new THREE.PerspectiveCamera(100, window.innerWidth / window.innerHeight, 0.08, 12000);
  camera.rotation.order = 'YXZ';

  const sky = createSky({
    colorSky: SKY_COLOR,
    colorHorizon: HORIZON_COLOR,
    colorClouds: CLOUD_COLOR,
    colorGlow: GLOW_COLOR,
    glowStrength: 0.3,
    starStrength: 1.0,
    cloudsTexture: makeCloudTexture(),
    flowTexture: makeFlowTexture(),
  });
  sky.material.uniforms.uCloudCover.value = 0.28;   // thin night clouds, stars stay visible
  sky.material.uniforms.uCloudScale.value = 2.5;
  scene.add(sky);

  // phase 3 at night — moonlight, soft shadows, cool hemisphere fill
  const sun = new THREE.DirectionalLight(SUN_COLOR, 0.85);
  sun.position.set(-110, 44, 62);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 400;
  sun.shadow.camera.left = -120;
  sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120;
  sun.shadow.camera.bottom = -120;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  scene.add(sun);
  const hemi = new THREE.HemisphereLight('#1d4a55', '#0a1016', 0.7);  // teal night sky, dark ground
  const ambient = new THREE.AmbientLight('#0e2f2c', 0.9);             // faint neon-teal wash
  scene.add(hemi);
  scene.add(ambient);

  // phase 6 — composer
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const gradePass = new ShaderPass(WarmGradeShader);
  composer.addPass(gradePass);
  composer.addPass(new SMAAPass(
    window.innerWidth * renderer.getPixelRatio(),
    window.innerHeight * renderer.getPixelRatio()
  ));
  composer.addPass(new OutputPass());

  // ---- the map
  const draco = new DRACOLoader().setDecoderPath('https://unpkg.com/three@0.169.0/examples/jsm/libs/draco/gltf/');
  const loader = new GLTFLoader().setDRACOLoader(draco);

  let map = null;
  let grass = null;
  let mapId = null;
  const lamps = new THREE.Group();
  scene.add(lamps);

  // Hang a point light under each light fitting the model ships. Capped, spread evenly
  // through the list rather than taking the first N, so the pools cover the whole floor
  // instead of clustering in one corner — every one of these costs every lit fragment.
  function fitLamps(cfg) {
    lamps.clear();
    if (!cfg.lamps || !map) return;
    const fittings = [];
    const at = new THREE.Vector3();
    map.traverse((child) => {
      // A multi-material fitting arrives as a Group of Meshes, so match any node — but
      // skip one whose parent matched too, or every lamp gets counted several times.
      if (!cfg.lamps.match.test(child.name)) return;
      if (child.parent && cfg.lamps.match.test(child.parent.name)) return;
      fittings.push(child.getWorldPosition(at).clone());
    });
    const stride = Math.max(1, Math.ceil(fittings.length / cfg.lamps.max));
    for (let i = 0; i < fittings.length; i += stride) {
      const light = new THREE.PointLight(cfg.lamps.color, cfg.lamps.intensity, cfg.lamps.distance, 2);
      light.position.copy(fittings[i]);
      lamps.add(light);
    }
  }

  // Maps are built once and kept, because rebuilding one is not cheap: scattering the
  // city's grass alone means 8000 raycasts against a 235k-triangle model, which stalls
  // the tab for the better part of ten seconds. Holding both resident costs a few tens of
  // megabytes and makes every switch after the first one instant. Revisit if this ever
  // grows past a handful of maps.
  const built = new Map();

  // Sky and haze belong outdoors. Inside, the sky dome would show through the roof and
  // 340m of fog would never engage, so the shed gets its own lighting rig instead.
  function applyEnvironment(cfg, bounds) {
    sky.visible = !cfg.interior;

    if (cfg.interior) {
      scene.background = new THREE.Color(INTERIOR_FOG);
      scene.fog = new THREE.Fog(INTERIOR_FOG, 14, 78);
      // Warm key against cool fill: the lamps read as sodium without the whole shed going
      // sepia, which is what happens if the ambient is warm too — and sepia is the one
      // thing this game's teal-and-pink palette can't absorb.
      sun.color.set(INTERIOR_LAMP);
      sun.intensity = 0.7;                     // roof lights, not moonlight
      sun.position.set(-26, 58, 18);
      sun.shadow.camera.far = 160;
      hemi.color.set('#3a4a55');               // cool bounce off the roof deck
      hemi.groundColor.set('#0d1114');
      hemi.intensity = 0.9;
      ambient.color.set('#1a2a2e');
      ambient.intensity = 1.2;                 // no sky fill indoors, so lift the floor
    } else {
      scene.background = new THREE.Color(HORIZON_COLOR);
      scene.fog = new THREE.Fog(HORIZON_COLOR, 70, 340);
      sun.color.set(SUN_COLOR);
      sun.intensity = 0.85;
      sun.position.set(-110, 44, 62);
      sun.shadow.camera.far = 400;
      hemi.color.set('#1d4a55');
      hemi.groundColor.set('#0a1016');
      hemi.intensity = 0.7;
      ambient.color.set('#0e2f2c');
      ambient.intensity = 0.9;
    }

    // Fit the shadow frustum to the map. The old fixed ±120 both wasted half the depth
    // range on a 35m warehouse and fell short of the 192m city.
    const extent = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 0.5 + 8;
    sun.shadow.camera.left = -extent;
    sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent;
    sun.shadow.camera.bottom = -extent;
    sun.shadow.camera.updateProjectionMatrix();
  }

  /** Load a map by id from maps.js, replacing whatever is loaded now. */
  async function setMap(id, onLoad = () => {}) {
    const cfg = MAPS[id];
    if (!cfg) throw new Error(`unknown map: ${id}`);

    if (map) scene.remove(map);
    if (grass) scene.remove(grass);

    let entry = built.get(id);
    if (!entry) {
      onLoad('loading map', 0);
      const gltf = await loader.loadAsync(
        cfg.file,
        (e) => { if (e.total) onLoad('loading map', e.loaded / e.total); },
      );

      const root = gltf.scene;
      // Scale first: collision, spawns and the shadow frustum all read world-space bounds,
      // and every one of them would be wrong by this factor if it were applied later.
      root.scale.setScalar(cfg.scale);
      root.updateMatrixWorld(true);
      root.traverse((child) => {
        if (!child.isMesh) return;
        stylize(child);
        if (cfg.letLightThrough?.test(labelOf(child))) child.castShadow = false;
      });

      let blades = null;
      if (cfg.grass) {
        onLoad('planting grass', 0.5);
        blades = createGrass(root, { gradientMap });
      }
      entry = { root, grass: blades };
      built.set(id, entry);
    }

    map = entry.root;
    grass = entry.grass;
    scene.add(map);
    if (grass) scene.add(grass);

    fitLamps(cfg);
    applyEnvironment(cfg, new THREE.Box3().setFromObject(map));
    renderer.shadowMap.needsUpdate = true;
    mapId = id;
    return map;
  }

  await setMap(MAPS[initialMap] ? initialMap : DEFAULT_MAP, onProgress);

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', resize);

  return {
    renderer, scene, camera, composer, sky, sun, gradePass, setMap,
    get map() { return map; },
    get grass() { return grass; },
    get mapId() { return mapId; },
    get config() { return MAPS[mapId]; },
  };
}
