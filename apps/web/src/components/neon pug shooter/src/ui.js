import * as THREE from 'three';
import { ACHIEVEMENTS } from './achievements.js';

const $ = (sel) => document.querySelector(sel);

export function createUI({ settings, onResume, onQuit, onRematch, onPause, onSetting }) {
  const el = {
    loading: $('#loading'),
    loadingBar: $('#loading-bar'),
    loadingLabel: $('#loading-label'),
    options: $('#options'),
    hud: $('#hud'),
    crosshair: $('#crosshair'),
    damageNumbers: $('#damage-numbers'),
    kills: $('#hud-kills'),
    health: $('#hud-health'),
    health2: $('#hud-health2'),
    healthBar: $('#hud-health-bar'),
    ammo: $('#hud-ammo'),
    ammoLabel: $('#hud-ammo-label'),
    ammoChip: $('#chip-ammo'),
    speed: $('#hud-speed'),
    speedChip: $('#chip-speed'),
    bhop: $('#bhop-tag'),
    score: $('#hud-score'),
    leaderboardRows: $('#leaderboard-rows'),
    minimap: $('#minimap-canvas'),
    killfeed: $('#killfeed'),
    mapCredit: $('#map-credit'),
    respawn: $('#respawn'),
    respawnTimer: $('#respawn-timer'),
    scoreboard: $('#scoreboard'),
    scoreboardCard: $('#scoreboard-card'),
    killNotes: $('#kill-notifications'),
    killPoints: $('#kill-points'),
    achievements: $('#achievements'),
    hitGlow: $('#hit-glow'),
    killGlow: $('#kill-glow'),
    headshotBanner: $('#headshot-banner'),
    streak: $('#streak'),
    streakIcon: $('#streak-icon'),
    streakText: $('#streak-text'),
    killcam: $('#killcam'),
    killcamTitle: $('#killcam-title'),
    killcamHint: $('#killcam-hint'),
    killcamSkipSep: $('#ks-skip-sep'),
    killcamBar: $('#killcam-bar i'),
    ksKiller: $('#ks-killer'),
    ksWeapon: $('#ks-weapon'),
    ksTime: $('#ks-time'),
    pause: $('#pause'),
    nameplates: $('#nameplates'),
    matchOver: $('#match-over'),
    matchOverTitle: $('#match-over-title'),
    matchOverDetail: $('#match-over-detail'),
    matchOverBoard: $('#match-over-board'),
  };

  // The main menu used to live here; the arcade's React lobby owns mode/map/difficulty
  // now, so the game only keeps its in-match overlays (pause, options, results).

  function bindSlider(id, key, format = (v) => v) {
    const input = document.getElementById(id);
    const label = document.getElementById(id + '-label');
    if (!input) return;
    input.value = settings[key];
    label.textContent = format(settings[key]);
    input.addEventListener('input', () => {
      settings[key] = parseFloat(input.value);
      label.textContent = format(settings[key]);
      onSetting?.(key, settings[key]);
    });
  }
  bindSlider('sensitivity', 'sensitivity', (v) => v.toFixed(2));
  bindSlider('fov', 'fov', (v) => Math.round(v) + '°');
  bindSlider('stretch', 'stretch', (v) => v.toFixed(2) + '×');
  bindSlider('volume', 'volume', (v) => Math.round(v * 100) + '%');

  // ---- options: reached from the pause screen; Back lands on Pause, with the match
  // still paused behind it.
  let optionsFrom = null;
  function openOptions(from) {
    optionsFrom = from;
    el[from].classList.add('hidden');
    el.options.classList.remove('hidden');
  }
  function closeOptions() {
    if (!optionsFrom) return;
    el.options.classList.add('hidden');
    el[optionsFrom].classList.remove('hidden');
    optionsFrom = null;
  }
  $('#pause-options-button')?.addEventListener('click', () => openOptions('pause'));
  $('#options-back')?.addEventListener('click', () => closeOptions());

  $('#resume-button')?.addEventListener('click', () => onResume());
  $('#quit-button')?.addEventListener('click', () => onQuit());
  $('#again-button')?.addEventListener('click', () => onQuit());
  $('#rematch-button')?.addEventListener('click', () => onRematch?.());
  $('#hud-menu-btn')?.addEventListener('click', () => onPause?.());

  // ---- loading
  function setProgress(label, fraction) {
    el.loadingLabel.textContent = label;
    el.loadingBar.style.width = `${Math.round(THREE.MathUtils.clamp(fraction, 0, 1) * 100)}%`;
  }
  // swapping maps brings the bar back mid-session; the match start drops it
  function showLoading(show) { el.loading.classList.toggle('hidden', !show); }

  // ---- crosshair: fixed cross, parked on the true aim point
  function updateCrosshair(ads, offsetX = 0, offsetY = 0) {
    el.crosshair.classList.toggle('ads', ads > 0.5);
    el.crosshair.style.transform = `translate(${offsetX.toFixed(1)}px, ${offsetY.toFixed(1)}px)`;
  }

  // the aim point can swing behind the camera — better no crosshair than one pinned to
  // the wrong side of the screen
  function showCrosshair(show) {
    el.crosshair.classList.toggle('hidden', !show);
  }

  // ---- damage numbers — AsteroidsCore's floating "-N", anchored to the hit in world space
  const DAMAGE_LIFE = 1.0;
  const damageNumbers = [];

  function addDamageNumber(point, amount, headshot = false) {
    if (!point || amount <= 0) return;
    const node = document.createElement('div');
    node.className = 'dmg-num' + (headshot ? ' head' : '');
    node.textContent = `-${Math.round(amount)}`;
    el.damageNumbers.appendChild(node);
    damageNumbers.push({
      node,
      world: point.clone(),
      life: DAMAGE_LIFE,
      drift: (Math.random() - 0.5) * 26,   // slight sideways scatter so stacked hits stay readable
    });
  }

  const _projected = new THREE.Vector3();
  function updateDamageNumbers(camera, dt) {
    for (let i = damageNumbers.length - 1; i >= 0; i--) {
      const d = damageNumbers[i];
      d.life -= dt;
      if (d.life <= 0) {
        d.node.remove();
        damageNumbers.splice(i, 1);
        continue;
      }
      const k = d.life / DAMAGE_LIFE;             // 1 -> 0
      _projected.copy(d.world).project(camera);
      if (_projected.z > 1) { d.node.style.opacity = '0'; continue; }
      const x = (_projected.x * 0.5 + 0.5) * window.innerWidth + d.drift * (1 - k);
      const y = (-_projected.y * 0.5 + 0.5) * window.innerHeight - (1 - k) * 46;
      d.node.style.left = `${x.toFixed(1)}px`;
      d.node.style.top = `${y.toFixed(1)}px`;
      d.node.style.opacity = String(Math.min(1, k * 1.6));
      d.node.style.transform = `translate(-50%, -50%) scale(${(0.85 + k * 0.25).toFixed(2)})`;
    }
  }

  function clearDamageNumbers() {
    for (const d of damageNumbers) d.node.remove();
    damageNumbers.length = 0;
  }

  // ---- "KILLED <name>" — AsteroidsCore's kill notification, 90 frames ≈ 1.5s
  function addKillNotification(name, headshot = false) {
    const note = document.createElement('div');
    note.className = 'kill-note';
    note.innerHTML = headshot
      ? `<span class="verb hs">HEADSHOT </span><span class="who"></span>`
      : `<span class="verb">KILLED </span><span class="who"></span>`;
    note.querySelector('.who').textContent = name;
    el.killNotes.appendChild(note);
    setTimeout(() => note.classList.add('fade'), 1000);
    setTimeout(() => note.remove(), 1600);
  }

  // ---- screen glows
  // Each hit or kill re-pulses its glow from full brightness rather than queueing another
  // one, so a burst of fire reads as one sustained rim of light instead of a stutter. It
  // clears itself after three quiet seconds.
  const GLOW_HOLD = 3000;

  function glowPulser(node) {
    let timer = null;
    return {
      pulse() {
        node.classList.remove('on');
        void node.offsetWidth;            // restart the animation at its peak
        node.classList.add('on');
        clearTimeout(timer);
        timer = setTimeout(() => node.classList.remove('on'), GLOW_HOLD);
      },
      clear() { clearTimeout(timer); node.classList.remove('on'); },
    };
  }
  const hitGlow = glowPulser(el.hitGlow);
  const killGlow = glowPulser(el.killGlow);

  // ---- kill points
  // A running total, not a per-kill flash. Killing again while the number is still up adds
  // to it rather than restarting it, so a streak reads as one climbing figure; it only
  // clears after three quiet seconds.
  const POINTS_WINDOW = 3000;
  let pointsTotal = 0;
  let pointsTimer = null;

  function addKillPoints(points) {
    pointsTotal += points;
    el.killPoints.textContent = `+${pointsTotal}`;
    el.killPoints.classList.remove('show');
    void el.killPoints.offsetWidth;            // restart the pop on every kill
    el.killPoints.classList.add('show');
    clearTimeout(pointsTimer);
    pointsTimer = setTimeout(resetKillPoints, POINTS_WINDOW);
  }

  function resetKillPoints() {
    clearTimeout(pointsTimer);
    pointsTotal = 0;
    el.killPoints.classList.remove('show');
  }

  // ---- achievement badges: rounded square, icon over the name
  const ACHV_ICONS = {
    revenge: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`,
    survivor: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 5.6a5.5 5.5 0 0 0-8.8 1.4 5.5 5.5 0 0 0-8.8-1.4c-2.3 2.2-2.1 5.9.4 8.3L12 21l8.4-7.1c2.5-2.4 2.7-6.1.4-8.3Z"/><path d="M3.5 12.5h4l1.5-3 2 5 1.5-2.5h4"/></svg>`,
    rampage: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c1.5 3.5-.5 5 0 7 2.5-1 3-3.5 3-3.5 2 2.5 3 4.8 3 7.5a6 6 0 0 1-12 0c0-2.6 1.5-4.8 3-6.5.6 1.2 1.4 1.8 2 2 .3-2.2-.6-4.4-1-6.5Z"/></svg>`,
    avenge: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="M3 21l6-6"/><path d="M21 3h-3l-4 4"/></svg>`,
    saviour: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 11 2 2 4-4"/></svg>`,
    pro: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="6"/><path d="m8.2 14.3-1.4 6.4 5.2-2.6 5.2 2.6-1.4-6.4"/></svg>`,
    onetap: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>`,
  };

  function showAchievements(ids) {
    for (const id of ids) {
      const meta = ACHIEVEMENTS[id];
      if (!meta) continue;
      const badge = document.createElement('div');
      badge.className = 'achv';
      badge.innerHTML = `<span class="achv-icon">${ACHV_ICONS[id] ?? ''}</span>` +
        `<span class="achv-name"></span>`;
      badge.querySelector('.achv-name').textContent = meta.label;
      el.achievements.appendChild(badge);
      requestAnimationFrame(() => badge.classList.add('show'));
      setTimeout(() => badge.classList.add('fade'), 2200);
      setTimeout(() => badge.remove(), 2700);
    }
  }

  // ---- headshot kill indicator
  let headshotTimer = null;
  function showHeadshot() {
    el.headshotBanner.classList.remove('show');
    void el.headshotBanner.offsetWidth;      // restart the pop on back-to-back headshots
    el.headshotBanner.classList.add('show');
    clearTimeout(headshotTimer);
    headshotTimer = setTimeout(() => el.headshotBanner.classList.remove('show'), 950);
  }

  // ---- killstreaks — same tiers, names and banner as AsteroidsCore
  const ICONS = {
    flame: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c1.5 3.5-.5 5 0 7 2.5-1 3-3.5 3-3.5 2 2.5 3 4.8 3 7.5a6 6 0 0 1-12 0c0-2.6 1.5-4.8 3-6.5.6 1.2 1.4 1.8 2 2 .3-2.2-.6-4.4-1-6.5Z"/></svg>`,
    zap: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#facc15" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>`,
    sword: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/></svg>`,
    shield: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`,
    radiation: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.5"/><path d="M12 9.5V3a9 9 0 0 0-4.5 1.2l3 5.3"/><path d="m14.2 13.2 5.6 3.3A9 9 0 0 0 21 12h-6.5"/><path d="m9.8 13.2-5.6 3.3A9 9 0 0 0 12 21v-6.5"/></svg>`,
  };
  const STREAK_TIERS = [
    { at: 5,  text: 'BLOOD THIRSTY', icon: 'flame' },
    { at: 10, text: 'MERCILESS',     icon: 'zap' },
    { at: 15, text: 'SLAYER',        icon: 'sword' },
    { at: 25, text: 'JUGGERNAUT',    icon: 'shield' },
    { at: 30, text: 'NUKE',          icon: 'radiation' },
  ];
  let streakTimer = null;

  function showStreak(count) {
    const tier = STREAK_TIERS.find((t) => t.at === count);
    if (!tier) return false;
    el.streakIcon.innerHTML = ICONS[tier.icon];
    el.streakText.textContent = tier.text;
    el.streak.classList.remove('show');
    void el.streak.offsetWidth;
    el.streak.classList.add('show');
    clearTimeout(streakTimer);
    streakTimer = setTimeout(() => el.streak.classList.remove('show'), 3000);
    return true;
  }

  // ---- killcam
  function showKillcam(show, opts = {}) {
    el.killcam.classList.toggle('hidden', !show);
    el.hud.classList.toggle('cam', show);
    if (!show) return;

    const {
      title = 'Killcam', subject = '', weapon = '—', headshot = false,
      skippable = true, progress = 0, timeLeft = 0,
    } = opts;

    el.killcamTitle.textContent = title;
    // both cams get the letterboxed cinematic look; only the final one is teal + unskippable
    el.killcam.classList.add('cinematic');
    el.killcam.classList.toggle('final', !skippable);
    el.ksKiller.textContent = subject || 'the map';
    el.ksWeapon.innerHTML = headshot
      ? `${weapon}<span class="ks-tag">Headshot</span>`
      : weapon;
    clearDamageNumbers();   // the replay stages its own
    el.killcamHint.classList.toggle('hidden', !skippable);
    el.killcamSkipSep?.classList.toggle('hidden', !skippable);
    el.killcamBar.style.width = `${Math.round(progress * 100)}%`;
    setKillcamTime(timeLeft);
  }

  function updateKillcamProgress(progress) {
    el.killcamBar.style.width = `${Math.round(THREE.MathUtils.clamp(progress, 0, 1) * 100)}%`;
  }

  function setKillcamTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    el.ksTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // ---- killfeed
  const RIFLE_ICON = `<svg width="30" height="15" viewBox="0 0 30 15" fill="currentColor" aria-hidden="true">
    <rect x="3" y="4.4" width="24" height="3" rx="1.1"/>
    <rect x="18" y="1.8" width="7" height="1.9" rx=".9"/>
    <path d="M9.4 7.4h3.6l-1.1 4.9c-.16.7-.78 1.2-1.5 1.2H8.8c-1 0-1.72-.94-1.47-1.9L9.4 7.4Z"/>
    <path d="M3 7.4h3.1v1.8c0 .6-.5 1.1-1.1 1.1H3.7A.7.7 0 0 1 3 9.6V7.4Z"/>
    <rect x="14.2" y="7.4" width="2.4" height="2.7" rx=".9"/>
  </svg>`;
  const SKULL_ICON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2C7 2 3 5.9 3 10.7c0 2.6 1.2 4.9 3.1 6.5.3.25.5.6.5 1V20a2 2 0 0 0 2 2h1.1v-2.6h1.7V22h1.7v-2.6h1.7V22h1.1a2 2 0 0 0 2-2v-1.8c0-.4.2-.75.5-1 1.9-1.6 3.1-3.9 3.1-6.5C21 5.9 17 2 12 2ZM8.6 13.2a2.15 2.15 0 1 1 0-4.3 2.15 2.15 0 0 1 0 4.3Zm6.8 0a2.15 2.15 0 1 1 0-4.3 2.15 2.15 0 0 1 0 4.3Z"/>
  </svg>`;

  // Each side of the row is a filled chip: your side blue, theirs orange, you brighter
  // still. `playerTeam` is what decides "your side" — in free-for-all every bot is its own
  // team, so only you ever come out blue.
  function chip(entity, playerTeam) {
    const mine = !!entity.isPlayer;
    const side = mine ? 'me' : (entity.team === playerTeam ? 'ally' : 'enemy');
    const name = mine ? 'you' : entity.name;
    const node = document.createElement('span');
    node.className = `kf-name ${side}`;
    node.textContent = name;
    return node;
  }

  function addKill(killer, victim, headshot, playerTeam) {
    const row = document.createElement('div');
    row.className = 'killfeed-row';
    const icon = document.createElement('span');
    icon.className = 'kf-icon' + (headshot ? ' head' : '');
    icon.innerHTML = headshot ? SKULL_ICON : RIFLE_ICON;
    row.append(chip(killer, playerTeam), icon, chip(victim, playerTeam));
    el.killfeed.appendChild(row);
    setTimeout(() => row.classList.add('fade'), 3200);
    setTimeout(() => row.remove(), 3900);
  }

  // ---- nameplates
  const plates = new Map();
  const worldPos = new THREE.Vector3();

  function updateNameplates(entities, camera, playerEntity) {
    for (const e of entities) {
      if (e === playerEntity) continue;
      let plate = plates.get(e);
      if (!plate) {
        plate = document.createElement('div');
        plate.className = 'nameplate';
        plate.innerHTML = `<span class="np-name"></span><span class="np-bar"><i></i></span>`;
        el.nameplates.appendChild(plate);
        plates.set(e, plate);
      }
      if (!e.alive) { plate.style.display = 'none'; continue; }

      worldPos.copy(e.position);
      worldPos.y += 2.1;
      worldPos.project(camera);
      const behind = worldPos.z > 1;
      if (behind || Math.abs(worldPos.x) > 1.1 || Math.abs(worldPos.y) > 1.1) {
        plate.style.display = 'none';
        continue;
      }
      const dist = camera.position.distanceTo(e.position);
      plate.style.display = 'block';
      plate.style.left = `${(worldPos.x * 0.5 + 0.5) * window.innerWidth}px`;
      plate.style.top = `${(-worldPos.y * 0.5 + 0.5) * window.innerHeight}px`;
      plate.style.opacity = String(THREE.MathUtils.clamp(1.1 - dist / 90, 0.15, 1));
      plate.classList.toggle('enemy', e.team !== playerEntity.team);
      plate.classList.toggle('ally', e.team === playerEntity.team);
      plate.querySelector('.np-name').textContent = e.name;
      plate.querySelector('.np-bar i').style.width = `${Math.max(0, e.health)}%`;
    }
  }

  function clearNameplates() {
    for (const plate of plates.values()) plate.remove();
    plates.clear();
  }

  // ---- hud (AsteroidsCore layout: chips, zone card, leaderboard, minimap, status bar)
  const mapCtx = el.minimap?.getContext('2d');
  let lbSignature = '';

  function updateHud({ health, kills, ammo, reserve, magSize, reloading, reloadFrac = 0, speed, bhopChain, bhopLocked = false, scoreText, leaderboard, minimap }) {
    const hp = Math.max(0, Math.ceil(health));
    el.kills.textContent = kills;
    el.health.textContent = `${hp}%`;
    el.health2.textContent = `${hp}%`;
    el.healthBar.style.width = `${Math.max(0, health)}%`;
    el.healthBar.classList.toggle('low', health < 30);

    el.ammo.textContent = `${ammo} / ${reserve}`;
    el.ammoLabel.innerHTML = reloading
      ? `Ammo (${Math.floor(reloadFrac * 100)}%)`
      : `Ammo <kbd>PRESS R</kbd>`;
    el.ammoChip.classList.toggle('empty', ammo === 0 && !reloading);

    el.speed.textContent = speed.toFixed(1);
    el.speedChip.classList.toggle('active', bhopChain > 1);
    el.bhop.classList.toggle('active', bhopChain > 1);
    el.bhop.classList.toggle('locked', bhopLocked);
    el.bhop.textContent = bhopChain > 1
      ? (bhopLocked ? `bhop ×${bhopChain} · locked` : `bhop ×${bhopChain}`)
      : '';

    el.score.innerHTML = scoreText;

    if (leaderboard) {
      const sig = leaderboard.map((r) => `${r.name}${r.kills}`).join('|');
      if (sig !== lbSignature) {
        lbSignature = sig;
        el.leaderboardRows.innerHTML = leaderboard.slice(0, 6).map((r, i) => `
          <div class="lb-row ${r.isPlayer ? 'me' : ''}">
            <span class="rank">#${i + 1}</span>
            <span class="name">${r.name}</span>
            <span class="k">${r.kills}</span>
          </div>`).join('');
      }
    }

    if (minimap && mapCtx) drawMinimap(minimap);
  }

  // circular minimap — teal player dot, pink enemies, teal-blue allies
  function drawMinimap({ entities, playerEntity, bounds }) {
    const S = 150;
    const ctx = mapCtx;
    ctx.clearRect(0, 0, S, S);

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath(); ctx.moveTo(0, S / 2); ctx.lineTo(S, S / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(S / 2, 0); ctx.lineTo(S / 2, S); ctx.stroke();

    const spanX = bounds.max.x - bounds.min.x;
    const spanZ = bounds.max.z - bounds.min.z;
    const toX = (x) => ((x - bounds.min.x) / spanX) * (S - 16) + 8;
    const toY = (z) => ((z - bounds.min.z) / spanZ) * (S - 16) + 8;

    for (const e of entities) {
      if (!e.alive) continue;
      const x = toX(e.position.x);
      const y = toY(e.position.z);
      if (e === playerEntity) {
        ctx.shadowColor = '#00FFD1';
        ctx.shadowBlur = 10;
        ctx.fillStyle = '#00FFD1';
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = e.team === playerEntity.team ? '#4aa8ff' : '#FF0080';
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---- scoreboard
  // Built as markup rather than a table so the same card can be dropped into the Tab
  // overlay and the results screen. The model comes from match.scoreboardModel(): one
  // group for free-for-all, one per side when there are teams.
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ratio = (kills, deaths) => (deaths > 0 ? kills / deaths : kills).toFixed(2);

  function scoreboardRow(row, index) {
    return `
      <div class="sb-row${row.isPlayer ? ' me' : ''}">
        <span class="sb-rank">${index + 1}</span>
        <span class="sb-dot" style="--dot:${escapeHtml(row.color)}"></span>
        <span class="sb-name">${escapeHtml(row.name)}</span>
        <span class="sb-num sb-score">${row.score}</span>
        <span class="sb-num">${row.kills}</span>
        <span class="sb-num">${row.deaths}</span>
        <span class="sb-num sb-kd">${ratio(row.kills, row.deaths)}</span>
      </div>`;
  }

  function scoreboardGroup(group) {
    // free-for-all groups carry no label — the list just runs on, unbroken
    const head = group.label ? `
      <div class="sb-group-head">
        <span class="sb-group-name">${escapeHtml(group.label)}</span>
        <span class="sb-rule"></span>
        <span class="sb-group-score">${group.score}</span>
      </div>` : '';
    return `
      <div class="sb-group${group.enemy ? ' enemy' : ''}">
        ${head}
        <div class="sb-row sb-head">
          <span></span><span></span><span>Player</span>
          <span class="sb-num">Score</span><span class="sb-num">K</span>
          <span class="sb-num">D</span><span class="sb-num sb-kd">K/D</span>
        </div>
        ${group.rows.map(scoreboardRow).join('')}
      </div>`;
  }

  function renderScoreboard(host, model) {
    if (!host || !model) return;
    host.innerHTML = `
      <div class="sb-title">
        <h3>${escapeHtml(model.title)}</h3>
        <p class="sb-sub">${escapeHtml(model.subtitle)}</p>
      </div>
      ${model.groups.map(scoreboardGroup).join('')}`;
  }

  function tick(dt, camera) {
    if (camera) updateDamageNumbers(camera, dt);
  }

  return {
    el,
    setProgress,
    showLoading,
    updateCrosshair,
    showCrosshair,
    addDamageNumber,
    clearDamageNumbers,
    addKillNotification,
    addKillPoints,
    resetKillPoints,
    pulseHitGlow: hitGlow.pulse,
    pulseKillGlow: killGlow.pulse,
    clearGlows() { hitGlow.clear(); killGlow.clear(); },
    showAchievements,
    showHeadshot,
    showStreak,
    showKillcam,
    updateKillcamProgress,
    setKillcamTime,
    addKill,
    updateNameplates,
    clearNameplates,
    updateHud,
    updateScoreboard(model) { renderScoreboard(el.scoreboardCard, model); },
    tick,
    setMapCredit(text) { el.mapCredit.textContent = text ?? ''; },
    // quitting or starting a match yanks the ground out from under Options, so drop it
    // outright instead of restoring whatever screen it was opened from
    dismissOptions() { el.options.classList.add('hidden'); optionsFrom = null; },
    showHud(show) { el.hud.classList.toggle('hidden', !show); },
    showPause(show) { el.pause.classList.toggle('hidden', !show); },
    showRespawn(show, seconds) {
      el.respawn.classList.toggle('hidden', !show);
      if (show) el.respawnTimer.textContent = Math.max(0, seconds).toFixed(1);
    },
    showScoreboard(show) { el.scoreboard.classList.toggle('hidden', !show); },
    showMatchOver(show, title, detail, model) {
      el.matchOver.classList.toggle('hidden', !show);
      if (!show) return;
      el.matchOverTitle.textContent = title;
      el.matchOverDetail.innerHTML = detail;
      renderScoreboard(el.matchOverBoard, model);
    },
  };
}
