// "The Hive" - 6 stacked hex-tile layers over a glowing slime pool.
// Tiles wobble 0.5s after being stepped on, then crumble. Rapier owns a
// fixed collider per living tile so ragdolls can flop onto floors.
import * as THREE from "three";
import { CFG } from "./config.js";

const SQRT3 = Math.sqrt(3);

export class Level {
  constructor(scene, RAPIER, world, { onCrumble } = {}) {
    this.scene = scene;
    this.RAPIER = RAPIER;
    this.world = world;
    this.onCrumble = onCrumble || (() => {});
    this.time = 0;
    this.layers = [];        // per layer: { mesh, rim, state, timer, colliders, active:Set }
    this.tiles = [];         // shared axial layout [{q,r,x,z}]
    this.tileIndex = new Map();  // "q,r" -> idx
    this.neighbors = [];     // idx -> [idx,...]
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this._e = new THREE.Euler();
  }

  // ---------- hex math (flat-top axial) ----------
  hexToWorld(q, r) {
    return { x: 1.5 * CFG.hexRadius * q, z: SQRT3 * CFG.hexRadius * (r + q / 2) };
  }
  worldToHex(x, z) {
    const R = CFG.hexRadius;
    const qf = (2 / 3) * x / R;
    const rf = (-x / 3 + (SQRT3 / 3) * z) / R;
    // cube round
    const sf = -qf - rf;
    let q = Math.round(qf), r = Math.round(rf), s = Math.round(sf);
    const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;
    return { q, r };
  }
  layerTopY(L) { return L * CFG.layerGap; }

  // ---------- build ----------
  build() {
    // shared layout
    const N = CFG.hexRings;
    for (let q = -N; q <= N; q++) {
      for (let r = Math.max(-N, -q - N); r <= Math.min(N, -q + N); r++) {
        const { x, z } = this.hexToWorld(q, r);
        this.tileIndex.set(q + "," + r, this.tiles.length);
        this.tiles.push({ q, r, x, z });
      }
    }
    const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    for (const t of this.tiles) {
      const ns = [];
      for (const [dq, dr] of DIRS) {
        const i = this.tileIndex.get((t.q + dq) + "," + (t.r + dr));
        if (i !== undefined) ns.push(i);
      }
      this.neighbors.push(ns);
    }

    const count = this.tiles.length;
    const R = CFG.hexRadius, H = CFG.tileHeight;
    const hexGeo = new THREE.CylinderGeometry(R * 0.985, R * 0.94, H, 6);
    const rimGeo = new THREE.CylinderGeometry(R * 1.005, R * 1.005, H * 0.3, 6, 1, true);

    for (let L = 0; L < CFG.layers; L++) {
      const color = new THREE.Color(CFG.layerColors[L]);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.32, metalness: 0.0,
        emissive: color.clone().multiplyScalar(0.12),
      });
      const mesh = new THREE.InstancedMesh(hexGeo, mat, count);
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      const rimColor = L === CFG.layers - 1 ? 0xccfff4 : CFG.rimColor;
      const rimMat = new THREE.MeshBasicMaterial({
        color: rimColor, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, toneMapped: false,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const rim = new THREE.InstancedMesh(rimGeo, rimMat, count);
      rim.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      const layer = {
        L, mesh, rim, color, rimMat,
        state: new Uint8Array(count),      // 0 alive, 1 wobble, 2 crumble, 3 dead
        timer: new Float32Array(count),
        colliders: new Array(count).fill(null),
        active: new Set(),
        aliveCount: count,
      };
      this._placeAll(layer);
      this.scene.add(mesh); this.scene.add(rim);
      this.layers.push(layer);
    }

    this._buildShards();
    this._buildSlime();
    this._buildSky();
    this._buildBillboards();
    this._buildLights();
  }

  _placeAll(layer) {
    const H = CFG.tileHeight;
    const y = this.layerTopY(layer.L) - H / 2;
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      this._m4.makeTranslation(t.x, y, t.z);
      layer.mesh.setMatrixAt(i, this._m4);
      layer.mesh.setColorAt(i, layer.color);
      this._m4.makeTranslation(t.x, y + H * 0.36, t.z);
      layer.rim.setMatrixAt(i, this._m4);
      // Rapier fixed collider (cylinder approximates the hex prism)
      const desc = this.RAPIER.ColliderDesc.cylinder(H / 2, CFG.hexRadius * 0.92)
        .setTranslation(t.x, y, t.z)
        .setCollisionGroups(0x00010002); // member TILE(1), collides with RAG(2)
      layer.colliders[i] = this.world.createCollider(desc);
    }
    layer.mesh.instanceMatrix.needsUpdate = true;
    layer.rim.instanceMatrix.needsUpdate = true;
    if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
  }

  reset() {
    for (const layer of this.layers) {
      layer.state.fill(0);
      layer.timer.fill(0);
      layer.active.clear();
      layer.aliveCount = this.tiles.length;
      for (const c of layer.colliders) { if (c) this.world.removeCollider(c, false); }
      layer.colliders.fill(null);
      this._placeAll(layer);
    }
    for (const s of this.shards) s.life = 0;
    for (const r of this.rings) r.life = 0;
  }

  // ---------- queries ----------
  solidAt(L, x, z) {
    if (L < 0 || L >= CFG.layers) return -1;
    const { q, r } = this.worldToHex(x, z);
    const idx = this.tileIndex.get(q + "," + r);
    if (idx === undefined) return -1;
    const st = this.layers[L].state[idx];
    return (st === 0 || st === 1) ? idx : -1;
  }

  touch(L, idx) {
    const layer = this.layers[L];
    if (layer.state[idx] !== 0) return;
    layer.state[idx] = 1;
    layer.timer[idx] = 0;
    layer.active.add(idx);
  }

  totalAlive() {
    let n = 0;
    for (const l of this.layers) n += l.aliveCount;
    return n;
  }

  // ---------- per-frame ----------
  update(dt, time) {
    this.time = time;
    const H = CFG.tileHeight;
    for (const layer of this.layers) {
      if (layer.active.size) {
        const yBase = this.layerTopY(layer.L) - H / 2;
        for (const idx of layer.active) {
          const t = this.tiles[idx];
          layer.timer[idx] += dt;
          const tm = layer.timer[idx];
          if (layer.state[idx] === 1) {                       // wobble
            if (tm >= CFG.tileWobbleTime) {
              layer.state[idx] = 2;
              layer.timer[idx] = 0;
              if (layer.colliders[idx]) {
                this.world.removeCollider(layer.colliders[idx], false);
                layer.colliders[idx] = null;
              }
              this.onCrumble({ x: t.x, y: yBase + H / 2, z: t.z }, layer.L);
              this._burstShards(t.x, yBase, t.z, layer.color);
            } else {
              const k = tm / CFG.tileWobbleTime;
              const sink = 0.05 * k;
              const jit = Math.sin(tm * 42) * 0.035 * k;
              this._q.setFromEuler(this._e.set(jit, 0, -jit));
              this._m4.compose(this._v.set(t.x, yBase - sink, t.z), this._q,
                               this._s.set(1, 1, 1));
              layer.mesh.setMatrixAt(idx, this._m4);
              this._m4.compose(this._v.set(t.x, yBase + H * 0.36 - sink, t.z), this._q, this._s);
              layer.rim.setMatrixAt(idx, this._m4);
              this._c.copy(layer.color).lerp(WHITE, 0.25 + 0.55 * k * (0.5 + 0.5 * Math.sin(tm * 30)));
              layer.mesh.setColorAt(idx, this._c);
            }
          } else if (layer.state[idx] === 2) {                // crumble
            const k = Math.min(1, layer.timer[idx] / CFG.tileCrumbleTime);
            if (k >= 1) {
              layer.state[idx] = 3;
              layer.aliveCount--;
              layer.active.delete(idx);
              this._m4.makeScale(0, 0, 0);
              layer.mesh.setMatrixAt(idx, this._m4);
              layer.rim.setMatrixAt(idx, this._m4);
            } else {
              const s = 1 - k;
              const drop = 1.4 * k * k;
              this._q.identity();
              this._m4.compose(this._v.set(t.x, yBase - drop, t.z), this._q,
                               this._s.set(s, s, s));
              layer.mesh.setMatrixAt(idx, this._m4);
              layer.rim.setMatrixAt(idx, this._m4);
            }
          }
        }
        layer.mesh.instanceMatrix.needsUpdate = true;
        layer.rim.instanceMatrix.needsUpdate = true;
        if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
      }
      layer.rimMat.opacity = 0.62 + 0.28 * Math.sin(time * 2.2 + layer.L * 1.1);
    }
    this._updateShards(dt);
    this._updateRings(dt);
    if (this.slimeMat) this.slimeMat.uniforms.uT.value = time;
    for (let i = 0; i < this.boards.length; i++) {
      const b = this.boards[i];
      b.rotation.z = Math.sin(time * 0.5 + i * 2.1) * 0.03;
      b.position.y = b.userData.y0 + Math.sin(time * 0.7 + i * 1.7) * 0.25;
    }
  }

  // ---------- shards ----------
  _buildShards() {
    const geo = new THREE.CylinderGeometry(CFG.hexRadius * 0.17, CFG.hexRadius * 0.14, 0.1, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
    this.shardMesh = new THREE.InstancedMesh(geo, mat, 90);
    this.shardMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shardMesh.frustumCulled = false;
    this.scene.add(this.shardMesh);
    this.shards = Array.from({ length: 90 }, () => ({
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      rot: new THREE.Euler(), rv: new THREE.Vector3(), life: 0,
    }));
    this.shardCursor = 0;
  }

  _burstShards(x, y, z, color) {
    for (let n = 0; n < 6; n++) {
      const idx = this.shardCursor;
      const s = this.shards[idx];
      this.shardCursor = (this.shardCursor + 1) % this.shards.length;
      s.pos.set(x + (Math.random() - 0.5) * 0.9, y, z + (Math.random() - 0.5) * 0.9);
      s.vel.set((Math.random() - 0.5) * 3.2, 1.5 + Math.random() * 2.4, (Math.random() - 0.5) * 3.2);
      s.rv.set(Math.random() * 7, Math.random() * 7, Math.random() * 7);
      s.life = 0.9;
      this.shardMesh.setColorAt(idx, color);
    }
    if (this.shardMesh.instanceColor) this.shardMesh.instanceColor.needsUpdate = true;
  }

  confetti(x, y, z) {
    for (let n = 0; n < 5; n++) {
      this._c.setHSL(Math.random(), 0.9, 0.62);
      this._burstShards(x + (Math.random() - 0.5) * 1.4, y + 1.2 + Math.random(),
                        z + (Math.random() - 0.5) * 1.4, this._c);
    }
  }

  _updateShards(dt) {
    let dirty = false;
    for (let i = 0; i < this.shards.length; i++) {
      const s = this.shards[i];
      if (s.life <= 0) continue;
      dirty = true;
      s.life -= dt;
      s.vel.y += CFG.gravity * 0.6 * dt;
      s.pos.addScaledVector(s.vel, dt);
      s.rot.x += s.rv.x * dt; s.rot.y += s.rv.y * dt; s.rot.z += s.rv.z * dt;
      const k = Math.max(0, s.life / 0.9);
      this._q.setFromEuler(s.rot);
      this._m4.compose(s.pos, this._q, this._s.set(k, k, k));
      this.shardMesh.setMatrixAt(i, this._m4);
      if (s.life <= 0) {
        this._m4.makeScale(0, 0, 0);
        this.shardMesh.setMatrixAt(i, this._m4);
      }
    }
    if (dirty) this.shardMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------- slime + splash ----------
  _buildSlime() {
    const geo = new THREE.CircleGeometry(46, 56);
    this.slimeMat = new THREE.ShaderMaterial({
      uniforms: {
        uT: { value: 0 },
        uDeep: { value: new THREE.Color(0x00806b) },
        uMint: { value: new THREE.Color(CFG.rimColor) },
        uFog: { value: new THREE.Color(CFG.fogColor) },
      },
      vertexShader: `
        varying vec2 vP;
        void main() {
          vP = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uT; uniform vec3 uDeep, uMint, uFog;
        varying vec2 vP;
        void main() {
          float d = length(vP);
          float ring = 0.5 + 0.5 * sin(d * 0.85 - uT * 1.7);
          ring = smoothstep(0.72, 1.0, ring) * 0.5;
          float swirl = 0.5 + 0.5 * sin(vP.x * 0.35 + uT * 0.9) * sin(vP.y * 0.35 - uT * 0.7);
          vec3 col = mix(uDeep, uMint, 0.22 + ring + swirl * 0.12);
          col = mix(col, uFog, smoothstep(28.0, 46.0, d));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.slimeMat.toneMapped = false;
    const slime = new THREE.Mesh(geo, this.slimeMat);
    slime.rotation.x = -Math.PI / 2;
    slime.position.y = CFG.slimeY;
    this.scene.add(slime);

    // splash rings pool
    this.rings = [];
    const rGeo = new THREE.RingGeometry(0.6, 0.9, 40);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.MeshBasicMaterial({
        color: CFG.rimColor, transparent: true, opacity: 0,
        side: THREE.DoubleSide, toneMapped: false, depthWrite: false,
      });
      const mesh = new THREE.Mesh(rGeo, m);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = CFG.slimeY + 0.03;
      mesh.visible = false;
      this.scene.add(mesh);
      this.rings.push({ mesh, life: 0 });
    }
  }

  splash(x, z) {
    const r = this.rings.find((r) => r.life <= 0) || this.rings[0];
    r.life = 0.8;
    r.mesh.visible = true;
    r.mesh.position.x = x; r.mesh.position.z = z;
  }

  _updateRings(dt) {
    for (const r of this.rings) {
      if (r.life <= 0) { r.mesh.visible = false; continue; }
      r.life -= dt;
      const k = 1 - Math.max(0, r.life / 0.8);
      const s = 0.6 + k * 5.5;
      r.mesh.scale.set(s, s, s);
      r.mesh.material.opacity = 0.9 * (1 - k);
    }
  }

  // ---------- sky, billboards, lights ----------
  _buildSky() {
    const geo = new THREE.SphereGeometry(170, 24, 14);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(CFG.skyTop) },
        uBot: { value: new THREE.Color(CFG.skyBottom) },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uTop, uBot;
        varying vec3 vDir;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main() {
          float h = vDir.y;
          vec3 col = mix(uBot, uTop, smoothstep(-0.12, 0.55, h));
          vec2 cell = floor(vDir.xz / max(0.06, vDir.y) * 18.0);
          float star = step(0.995, hash(cell)) * smoothstep(0.12, 0.4, h) * 0.8;
          col += vec3(star);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    mat.toneMapped = false;
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  setBillboardTexts(texts) { this._billboardTexts = texts; }

  _boardTexture(text, accent) {
    const cv = document.createElement("canvas");
    cv.width = 1024; cv.height = 256;
    const g = cv.getContext("2d");
    g.fillStyle = "rgba(13,8,36,0.92)";
    g.beginPath();
    g.roundRect(8, 8, 1008, 240, 26);
    g.fill();
    g.strokeStyle = accent; g.lineWidth = 8;
    g.stroke();
    g.font = "900 118px system-ui, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.shadowColor = accent; g.shadowBlur = 42;
    g.fillStyle = "#ffffff";
    g.fillText(text, 512, 136);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  _buildBillboards() {
    this.boards = [];
    const texts = this._billboardTexts || ["NEON CLUMSY", "DON'T STOP MOVING", "MIND THE GAP"];
    const accents = ["#00FFD1", "#ff5fa2", "#ffd84d"];
    const angles = [0.4, 2.5, 4.4];
    const heights = [15, 19.5, 16.5];   // sit in the upper half of the taller stack
    for (let i = 0; i < 3; i++) {
      const tex = this._boardTexture(texts[i], accents[i]);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true,
        side: THREE.FrontSide, toneMapped: false });
      const board = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.25), mat);
      const a = angles[i], rad = 21;
      board.position.set(Math.cos(a) * rad, heights[i], Math.sin(a) * rad);
      board.lookAt(0, heights[i] - 2, 0);
      board.userData.y0 = heights[i];
      this.scene.add(board);
      this.boards.push(board);

      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.14, heights[i] - CFG.slimeY + 1, 8),
        new THREE.MeshStandardMaterial({ color: 0x2a1b5e, roughness: 0.5 }));
      pole.position.set(board.position.x, (heights[i] + CFG.slimeY) / 2 - 0.6, board.position.z);
      this.scene.add(pole);
    }
  }

  _buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x8a7cff, 0xff9fc7, 0.85));
    const dir = new THREE.DirectionalLight(0xfff2dd, 1.7);
    dir.position.set(16, 28, 12);
    if (CFG.shadows) {
      dir.castShadow = true;
      dir.shadow.mapSize.set(CFG.shadowMapSize, CFG.shadowMapSize);
      const S = 18;
      dir.shadow.camera.left = -S; dir.shadow.camera.right = S;
      dir.shadow.camera.top = S; dir.shadow.camera.bottom = -S;
      dir.shadow.camera.near = 4; dir.shadow.camera.far = 70;
      dir.shadow.bias = -0.0006;
    }
    this.scene.add(dir);
    const slimeGlow = new THREE.PointLight(CFG.rimColor, 60, 40, 1.9);
    slimeGlow.position.set(0, CFG.slimeY + 1.6, 0);
    this.scene.add(slimeGlow);
  }
}

const WHITE = new THREE.Color(0xffffff);
