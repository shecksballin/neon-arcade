import * as THREE from 'three';

const BODY_RADIUS = 0.42;
const BODY_BOTTOM = 0.12;
const BODY_TOP = 1.52;
const HEAD_CENTER = 1.66;
const HEAD_RADIUS = 0.24;

function softDot(size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,240,200,0.75)');
  g.addColorStop(1, 'rgba(255,220,160,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ray vs vertical cylinder, then vs head sphere; returns {dist, headshot} or null
function rayVsEntity(origin, dir, feet) {
  const ox = origin.x - feet.x, oz = origin.z - feet.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  let best = null;

  if (a > 1e-8) {
    const b = 2 * (ox * dir.x + oz * dir.z);
    const c = ox * ox + oz * oz - BODY_RADIUS * BODY_RADIUS;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t > 0) {
        const y = origin.y + dir.y * t - feet.y;
        if (y >= BODY_BOTTOM && y <= BODY_TOP) best = { dist: t, headshot: false };
      }
    }
  }

  const hx = origin.x - feet.x;
  const hy = origin.y - (feet.y + HEAD_CENTER);
  const hz = origin.z - feet.z;
  const hb = 2 * (hx * dir.x + hy * dir.y + hz * dir.z);
  const hc = hx * hx + hy * hy + hz * hz - HEAD_RADIUS * HEAD_RADIUS;
  const hdisc = hb * hb - 4 * hc;
  if (hdisc >= 0) {
    const t = (-hb - Math.sqrt(hdisc)) / 2;
    if (t > 0 && (!best || t < best.dist)) best = { dist: t, headshot: true };
  }

  return best;
}

export function createCombat({ scene, collision, onShot = null }) {
  const dotTexture = softDot();

  // pooled tracers
  const TRACERS = 28;
  const tracerGeom = new THREE.BufferGeometry();
  tracerGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const tracers = [];
  for (let i = 0; i < TRACERS; i++) {
    const geom = tracerGeom.clone();
    const line = new THREE.Line(geom, new THREE.LineBasicMaterial({
      color: 0xfff0b0, transparent: true, opacity: 0, depthWrite: false, fog: false,
    }));
    line.frustumCulled = false;
    line.visible = false;
    scene.add(line);
    tracers.push({ line, life: 0 });
  }
  let tracerCursor = 0;

  // pooled impact puffs
  const PUFFS = 24;
  const puffs = [];
  for (let i = 0; i < PUFFS; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: dotTexture, transparent: true, opacity: 0, depthWrite: false, fog: false,
    }));
    sprite.visible = false;
    scene.add(sprite);
    puffs.push({ sprite, life: 0, scale: 1 });
  }
  let puffCursor = 0;

  const flash = new THREE.PointLight(0xffdca8, 0, 9, 2);
  scene.add(flash);
  let flashLife = 0;

  const flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: dotTexture, color: 0xfff0c0, transparent: true, opacity: 0, depthWrite: false, fog: false,
  }));
  flashSprite.visible = false;
  scene.add(flashSprite);

  function spawnTracer(from, to) {
    const t = tracers[tracerCursor = (tracerCursor + 1) % TRACERS];
    const pos = t.line.geometry.attributes.position;
    pos.setXYZ(0, from.x, from.y, from.z);
    pos.setXYZ(1, to.x, to.y, to.z);
    pos.needsUpdate = true;
    t.line.visible = true;
    t.line.material.opacity = 0.9;
    t.life = 0.07;
  }

  function spawnImpact(point, color = 0xffe0a0, scale = 0.35) {
    const p = puffs[puffCursor = (puffCursor + 1) % PUFFS];
    p.sprite.position.copy(point);
    p.sprite.material.color.setHex(color);
    p.sprite.material.opacity = 0.95;
    p.sprite.scale.setScalar(scale);
    p.sprite.visible = true;
    p.life = 0.22;
    p.scale = scale;
  }

  const _dir = new THREE.Vector3();
  const _end = new THREE.Vector3();

  /**
   * One hitscan shot.
   * `shooter` is excluded; friendly fire is filtered by team upstream.
   */
  function fire({ origin, direction, shooter, entities, spread = 0, damage = 22, range = 220, muzzle = null,
                  allowHeadshot = true }) {
    _dir.copy(direction).normalize();
    if (spread > 0) {
      _dir.x += (Math.random() - 0.5) * spread;
      _dir.y += (Math.random() - 0.5) * spread;
      _dir.z += (Math.random() - 0.5) * spread;
      _dir.normalize();
    }

    const wallDist = collision.rayHit(origin, _dir, range);
    let hitDist = wallDist === null ? range : wallDist;
    let victim = null;
    let headshot = false;

    for (const e of entities) {
      if (e === shooter || !e.alive) continue;
      if (shooter.team != null && e.team === shooter.team) continue;
      const hit = rayVsEntity(origin, _dir, e.position);
      if (hit && hit.dist < hitDist) {
        hitDist = hit.dist;
        victim = e;
        headshot = hit.headshot;
      }
    }

    // A shooter on a headshot leash (see difficulty.js) still connects — the shot just
    // counts as a body hit. A ray that wandered through the head sphere on its own doesn't
    // get to be an instant kill.
    if (headshot && !allowHeadshot) headshot = false;

    _end.copy(origin).addScaledVector(_dir, hitDist);
    spawnTracer(muzzle || origin, _end);

    if (muzzle) {
      flash.position.copy(muzzle);
      flash.intensity = 14;
      flashLife = 0.05;
      flashSprite.position.copy(muzzle);
      flashSprite.scale.setScalar(0.42);
      flashSprite.material.opacity = 1;
      flashSprite.visible = true;
    }

    if (victim) {
      // headshots kill outright, whoever fired them
      const dmg = headshot ? 100000 : damage * (hitDist > 60 ? 0.75 : 1);
      // what the hit will actually take off — the number the HUD shows
      const dealt = Math.max(0, Math.round(Math.min(victim.health, dmg)));
      const lethal = dmg >= victim.health;
      spawnImpact(_end, headshot ? 0xff6b6b : 0xffb3b3, headshot ? 0.5 : 0.34);

      // victim.health is still pre-damage here — takeDamage runs on the caller's side —
      // so this is what they had when the bullet arrived. One Tap needs that.
      const result = { victim, damage: dmg, dealt, headshot, lethal, point: _end.clone(),
                       victimHealth: victim.health };
      onShot?.({ shooter, origin, end: _end, muzzle, hit: result });
      return result;
    }

    spawnImpact(_end, 0xdfe6ec, 0.28);
    onShot?.({ shooter, origin, end: _end, muzzle, hit: null });
    return null;
  }

  function update(dt) {
    for (const t of tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.line.material.opacity = Math.max(0, t.life / 0.07) * 0.9;
      if (t.life <= 0) t.line.visible = false;
    }
    for (const p of puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const k = Math.max(0, p.life / 0.22);
      p.sprite.material.opacity = k;
      p.sprite.scale.setScalar(p.scale * (1.6 - k * 0.6));
      if (p.life <= 0) p.sprite.visible = false;
    }
    if (flashLife > 0) {
      flashLife -= dt;
      const k = Math.max(0, flashLife / 0.05);
      flash.intensity = k * 14;
      flashSprite.material.opacity = k;
      if (flashLife <= 0) flashSprite.visible = false;
    }
  }

  // used by the killcam to re-stage a recorded shot without re-running the hit test
  function replayShot({ origin, end, muzzle }) {
    spawnTracer(muzzle || origin, end);
    if (muzzle) {
      flash.position.copy(muzzle);
      flash.intensity = 14;
      flashLife = 0.05;
      flashSprite.position.copy(muzzle);
      flashSprite.scale.setScalar(0.42);
      flashSprite.material.opacity = 1;
      flashSprite.visible = true;
    }
    spawnImpact(end, 0xdfe6ec, 0.26);
  }

  return { fire, update, spawnImpact, spawnTracer, replayShot, rayVsEntity };
}
