import * as THREE from 'three';

export function createSky({
  radius = 4000,
  colorSky = '#248fd5',      // zenith blue (from the demo)
  colorHorizon = '#caf0fe',  // pale cyan horizon (from the demo)
  colorClouds = '#ffe5c4',   // warm cloud tint (from the demo)
  colorGlow = '#00FFD1',     // neon rim hugging the horizon
  glowStrength = 0,          // 0 = off (daytime look)
  starStrength = 0,          // 0 = off; ~1 for a night sky
  cloudsTexture,             // THREE.Texture: a soft cloud/noise map (tileable)
  flowTexture,               // THREE.Texture: a flow/distortion map (optional)
} = {}) {

  if (cloudsTexture) cloudsTexture.wrapS = cloudsTexture.wrapT = THREE.RepeatWrapping;
  if (flowTexture)   flowTexture.wrapS   = flowTexture.wrapT   = THREE.RepeatWrapping;

  const uniforms = {
    uTime:         { value: 0 },
    uColorSky:     { value: new THREE.Color(colorSky) },
    uColorHorizon: { value: new THREE.Color(colorHorizon) },
    uColorClouds:  { value: new THREE.Color(colorClouds) },
    uCloudsMap:    { value: cloudsTexture || null },
    uFlowMap:      { value: flowTexture || null },
    uHasClouds:    { value: cloudsTexture ? 1 : 0 },
    uHasFlow:      { value: flowTexture ? 1 : 0 },
    uCloudScale:   { value: 2.0 },   // tiling of the cloud texture
    uCloudSpeed:   { value: 0.01 },  // drift speed
    uCloudCover:   { value: 0.5 },   // 0..1 how much sky is covered
    uHorizonPow:   { value: 3.0 },   // sharpness of the gradient falloff
    uColorGlow:    { value: new THREE.Color(colorGlow) },
    uGlowStrength: { value: glowStrength },
    uStarStrength: { value: starStrength },
  };

  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,   // render the inside of the dome
    depthWrite: false,      // sky never occludes scene geometry
    fog: false,
    uniforms,
    vertexShader: /* glsl */`
      varying vec3 vWorldDir;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldDir = normalize(world.xyz - cameraPosition);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vWorldDir;
      varying vec2 vUv;

      uniform float uTime;
      uniform vec3  uColorSky, uColorHorizon, uColorClouds, uColorGlow;
      uniform sampler2D uCloudsMap, uFlowMap;
      uniform int   uHasClouds, uHasFlow;
      uniform float uCloudScale, uCloudSpeed, uCloudCover, uHorizonPow;
      uniform float uGlowStrength, uStarStrength;

      float hash21(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      // sparse twinkling points on a plane projected over the dome
      float starField(vec3 dir) {
        vec2 uv = dir.xz / (dir.y + 0.55) * 16.0;
        vec2 id = floor(uv);
        vec2 gv = fract(uv) - 0.5;
        float rnd = hash21(id);
        if (rnd < 0.88) return 0.0;                       // density
        vec2 offs = vec2(hash21(id + 7.3), hash21(id + 3.1)) - 0.5;
        float d = length(gv - offs * 0.7);
        float size = 0.03 + hash21(id + 1.7) * 0.05;
        float star = smoothstep(size, 0.0, d);
        float tw = 0.6 + 0.4 * sin(uTime * (1.0 + rnd * 3.0) + rnd * 40.0);
        return star * tw;
      }

      void main() {
        // --- vertical gradient: horizon -> zenith based on view angle ---
        float h = clamp(vWorldDir.y, 0.0, 1.0);
        float t = 1.0 - pow(1.0 - h, uHorizonPow);
        vec3 col = mix(uColorHorizon, uColorSky, t);

        // --- stars, fading out toward the horizon haze ---
        if (uStarStrength > 0.0) {
          float stars = starField(normalize(vWorldDir)) * smoothstep(0.04, 0.3, h);
          col += vec3(0.85, 0.95, 1.0) * stars * uStarStrength;
        }

        // --- neon glow hugging the horizon ---
        col += uColorGlow * pow(1.0 - h, 7.0) * uGlowStrength;

        // --- scrolling, flow-distorted clouds ---
        if (uHasClouds == 1) {
          // Project onto a flat cloud plane overhead instead of using the sphere's uv:
          // sphere uvs pinch at the pole and tear at the seam when you look straight up.
          vec2 uv = (vWorldDir.xz / max(vWorldDir.y, 0.12)) * uCloudScale * 0.12;
          vec2 drift = vec2(uTime * uCloudSpeed, uTime * uCloudSpeed * 0.3);

          vec2 flow = vec2(0.0);
          if (uHasFlow == 1) {
            flow = (texture2D(uFlowMap, uv * 0.5 + drift * 0.5).rg - 0.5) * 0.1;
          }

          float clouds = texture2D(uCloudsMap, uv + drift + flow).r;
          // fade clouds out toward the horizon so they sit "up in the sky"
          clouds *= smoothstep(0.05, 0.5, h);
          clouds = smoothstep(1.0 - uCloudCover, 1.0, clouds);

          col = mix(col, uColorClouds, clouds);
        }

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });

  const geometry = new THREE.SphereGeometry(radius, 64, 32);
  const mesh = new THREE.Mesh(geometry, material);
  // Draw after the opaque scene: depthTest is on and the dome never writes depth, so any
  // pixel already covered by geometry rejects the star/cloud shader instead of paying for
  // it and then being painted over. (Camera far plane must stay >= the dome radius.)
  mesh.renderOrder = 999;

  // call this every frame from your loop
  mesh.tick = (elapsed) => { uniforms.uTime.value = elapsed; };

  return mesh;
}
