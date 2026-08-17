import * as THREE from 'three';
import { createWorld } from './world.js';
import { buildPhysics, createCollisionHandle } from './physics.js';
import { loadCharacterAssets } from './characters.js';
import { createCombat } from './combat.js';
import { createPlayer } from './player.js';
import { createMatch, MODES } from './match.js';
import { createUI } from './ui.js';
import { createReplay } from './replay.js';
import { createAudio } from './audio.js';
import { createAchievements, KILL_POINTS } from './achievements.js';
import { MAPS, DEFAULT_MAP } from './maps.js';
import { DIFFICULTIES, DEFAULT_DIFFICULTY } from './difficulty.js';

// The game no longer carries its own main menu — the arcade's React lobby is the menu.
// The match to boot into arrives on the query string, and quitting posts a message back
// to the parent frame, which unmounts the iframe and returns to the lobby.
const EXIT_MESSAGE = 'neon-pug-shooter:exit';
// Match results ride out the same way, so a game the server never sees still earns the
// arcade's XP (see reportResult below).
const RESULT_MESSAGE = 'neon-pug-shooter:result';
const query = new URLSearchParams(location.search);
const pick = (value, table, fallback) => (value && table[value] ? value : fallback);
const initialMatch = {
  mode: pick(query.get('mode'), MODES, 'ffa'),
  map: pick(query.get('map'), MAPS, DEFAULT_MAP),
  difficulty: pick(query.get('difficulty'), DIFFICULTIES, DEFAULT_DIFFICULTY),
};

const settings = {
  sensitivity: 1.0,
  fov: 103,          // wide by default — this is a stretched-FOV third person game
  adsFov: 62,
  stretch: 1.25,     // horizontal squeeze; 1.0 = normal, higher = classic "stretched res"
  volume: 0.7,
};

// Options persistence. The arcade lobby's Options panel (PugShooter/pugShooterOptions.ts)
// edits the same localStorage entry — the iframe is same-origin — so tuning made out in
// the lobby applies here at boot, and in-game slider changes carry back out. Ranges
// mirror the #options sliders in index.html.
const OPTIONS_KEY = 'pug_shooter_options';
const clampOption = (value, lo, hi, fallback) =>
  (Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback);

try {
  const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}');
  settings.sensitivity = clampOption(saved.sensitivity, 0.2, 3, settings.sensitivity);
  settings.fov = clampOption(saved.fov, 80, 120, settings.fov);
  settings.stretch = clampOption(saved.stretch, 1, 1.7, settings.stretch);
  settings.volume = clampOption(saved.volume, 0, 1, settings.volume);
} catch { /* corrupt entry — keep the defaults */ }

function persistOptions() {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify({
      sensitivity: settings.sensitivity,
      fov: settings.fov,
      stretch: settings.stretch,
      volume: settings.volume,
    }));
  } catch { /* storage blocked/full — options just won't stick */ }
}

let world, collision, combat, player, ui, match, replay, audio, achievements;
let running = false;
let paused = false;
let hurt = 0;
let streak = 0;          // kills without dying — drives the AsteroidsCore streak banner
let killcam = null;      // { killer, name, final }
let pendingCam = null;   // a killcam waiting out the post-kill capture window (see queueCam)
let simTime = 0;         // one clock for the recorder and the killcam, ticked by step()
let lastKill = null;     // { killer, victim, headshot, time } — the seed for the final cam
let pendingResult = null; // match result, held back until the final killcam finishes
let matchStartedAt = 0;  // stamped by startMatch; arms the one XP report (reportResult)

const clock = new THREE.Clock();

async function boot() {
  ui = createUI({
    settings,
    onResume: resume,
    onQuit: exitToLobby,
    onRematch: rematch,
    onSetting: (key, value) => {
      if (key === 'volume') audio?.setVolume(value);
      persistOptions();
    },
    onPause: () => {
      if (!running || paused || killcam || match?.over) return;
      paused = true;
      player.setEnabled(false);
      ui.showPause(true);
      document.exitPointerLock?.();
    },
  });

  world = await createWorld((label, fraction) => ui.setProgress(label, fraction * 0.55), initialMatch.map);
  ui.setProgress('building collision', 0.58);
  // A handle rather than the physics world itself: the player and bots hold onto this for
  // their whole lives, and swapping maps replaces what's behind it.
  collision = createCollisionHandle();
  await rebuildCollision((label, f) => ui.setProgress(label, 0.58 + f * 0.04));

  await loadCharacterAssets((label, fraction) => ui.setProgress(label, 0.6 + fraction * 0.35));

  audio = await createAudio({ volume: settings.volume });

  combat = createCombat({
    scene: world.scene,
    collision,
    // log every bullet so a killcam can re-stage the exchange, and fire the gun sound —
    // the player's own shot plays centred, everyone else's from where they stand
    onShot: (shot) => {
      if (running && !killcam) replay.recordShot(shot, simTime);
      audio.playGun(shot.shooter?.isPlayer ? null : shot.muzzle ?? shot.origin);
    },
  });

  replay = createReplay({
    camera: world.camera,
    collision,
    settings,
    yawOf: (e) => (e.isPlayer ? player.state.yaw + player.state.recoil.x : e.ai?.yaw ?? 0),
    // recoil included: the killcam should show where the shots actually went
    pitchOf: (e) => (e.isPlayer ? player.aimPitch : e.ai?.pitch ?? 0),
    // bots never crouch or aim down sights, so only the player's stance varies
    crouchOf: (e) => (e.isPlayer ? player.state.crouching : false),
    adsOf: (e) => (e.isPlayer ? player.state.adsAmount : 0),
    // A killcam shows the shooter's own screen: their tracers, their damage numbers,
    // their kill notification. Feedback is limited to the killer being followed.
    onShot: (shot) => {
      combat.replayShot(shot);
      audio.playGun(shot.muzzle ?? shot.origin);
      if (!shot.hit || !killcam || shot.shooter !== killcam.killer) return;
      ui.addDamageNumber(shot.hit.point, shot.hit.dealt, shot.hit.headshot);
      audio.playHitmarker();
      if (shot.hit.lethal) {
        const name = shot.hit.victim?.isPlayer ? 'you' : shot.hit.victim?.name ?? '';
        ui.addKillNotification(name, shot.hit.headshot);
        if (shot.hit.headshot) ui.showHeadshot();
        audio.playKill(shot.hit.headshot);
      }
    },
  });

  player = createPlayer({
    scene: world.scene,
    camera: world.camera,
    canvas: world.renderer.domElement,
    collision,
    combat,
    settings,
    // the reload's length is the sound effect's length; the animation is retimed to it
    reloadTime: audio.reloadDuration,
    hooks: {
      onReload: () => audio.playReload(),
      onHitConfirm: (result) => {
        ui.addDamageNumber(result.point, result.dealt, result.headshot);
        audio.playHitmarker();
      },
      onKill: (victim, headshot, context) => {
        const name = victim.isPlayer ? 'you' : victim.name;
        // score it before anything is drawn — the notification carries the points with it
        const earned = noteKill(player.entity, victim, headshot, context);
        ui.addKill(player.entity, victim, headshot, player.entity.team);
        ui.addKillNotification(name, headshot);
        ui.addKillPoints(earned?.points ?? KILL_POINTS);
        ui.pulseKillGlow();
        if (earned?.earned.length) ui.showAchievements(earned.earned);
        if (headshot) ui.showHeadshot();
        audio.playKill(headshot);
        ui.showStreak(++streak);
        match?.checkEnd();
      },
      onSpawn: () => achievements?.onRespawn(),
      onHurt: () => { hurt = 1; ui.pulseHitGlow(); },
      onDeath: (killer) => { streak = 0; queueCam({ kind: 'death', killer }); },
      onRespawnReady: () => {
        if (!match || match.over || killcam || pendingCam) return;
        ui.showRespawn(false);
        match.respawn(player.entity);
      },
    },
  });

  ui.setProgress('ready', 1);

  // handle for debugging from the console; step()/render() let you drive the sim by hand
  window.__game = {
    world, collision, combat, player, settings, replay, ui,
    get match() { return match; },
    get achievements() { return achievements; },
    get killcam() { return killcam; },
    get running() { return running; },
    get paused() { return paused; },
    setPaused(v) { paused = v; },
    step, render: () => world.composer.render(),
  };

  loop();

  // straight into the match the lobby asked for — the loading screen holds until it's live
  startMatch(initialMatch.mode, initialMatch.map, initialMatch.difficulty).catch(onLoadFailure);
}

// ---- maps -----------------------------------------------------------------
// Kept alongside the loaded maps in world.js, and for the same reason: baking a map into
// a Rapier trimesh means building a BVH over every triangle in it, which is not something
// to redo each time someone switches back.
const physicsByMap = new Map();

async function rebuildCollision(onProgress) {
  let physics = physicsByMap.get(world.mapId);
  if (!physics) {
    physics = await buildPhysics(world.map, world.config, onProgress);
    physicsByMap.set(world.mapId, physics);
  }
  collision.swap(physics);
}

// Swap the loaded map, then rebuild the physics world on top of it. Both are slow enough
// to be worth a progress bar, so the loading screen comes back while they run.
async function loadMap(id) {
  if (world.mapId === id) return;
  ui.showLoading(true);
  await world.setMap(id, (label, f) => ui.setProgress(label, f * 0.8));
  ui.setProgress('building collision', 0.85);
  await rebuildCollision((label, f) => ui.setProgress(label, 0.85 + f * 0.15));
  ui.setProgress('ready', 1);
  ui.showLoading(false);
}

// ---- kills ----------------------------------------------------------------
// Every kill in the match funnels through here — the player's and the bots' alike — which
// is what lets the killcam replay the last one and lets the achievements watch the feed as
// a sequence. Returns what the player earned, or null when it wasn't their kill.
function noteKill(killer, victim, headshot, context = {}) {
  // The winning kill is the one the final cam replays, and it's chosen two seconds after
  // the fact. Nothing logged after the whistle may take its place — belt and braces
  // alongside the invulnerability match.js drops on everyone at that moment.
  if (!match?.over) lastKill = { killer, victim, headshot, time: simTime };

  const earned = achievements?.record({
    killer, victim, at: simTime, headshot, oneTap: !!context.oneTap,
  }) ?? null;
  // bots bank the flat rate; only the player's kills are worth more than the base
  killer.score = (killer.score ?? 0) + (earned ? earned.points : KILL_POINTS);
  return earned;
}

const KILLCAM_SECONDS = 5;          // the death cam, before the post-kill tail
const FINAL_KILLCAM_SECONDS = 10;   // the closing montage, ditto
// A cam never cuts in on the frame of the kill. The sim runs on for this long first, so
// the recorder banks what actually happened afterwards — the killer walking off the shot,
// the body dropping — and the replay plays those seconds instead of freezing on the last
// frame. Every cam therefore ends this far past its kill.
const POST_KILL_SECONDS = 2;
const WEAPON_NAME = 'Neon Rifle';

// The match-winning kill outranks a death cam that's still waiting its turn.
function queueCam(cam) {
  if (pendingCam?.kind === 'final') return;
  pendingCam = { ...cam, timer: POST_KILL_SECONDS };
}

// what actually killed the player, for the "killed with" slot on the strip
function lastHitOn(victim) {
  return lastKill && lastKill.victim === victim ? lastKill : null;
}

function startKillcam(killer) {
  if (!match || match.over) { ui.showRespawn(true, 3); return; }
  // Over the killer's shoulder for the whole replay, not a chase shot that only resolves
  // into their POV at the end — a death cam should read as the game, played back. Only
  // the closing montage gets the cinematic treatment.
  const started = replay.start({
    victim: player.entity,
    killer,
    duration: KILLCAM_SECONDS + POST_KILL_SECONDS,
    elapsed: simTime,          // already POST_KILL_SECONDS past the death
    entities: match.entities,
    mode: 'pov',
  });
  if (!started) { ui.showRespawn(true, 3); return; }

  killcam = { killer, name: killer && !killer.isPlayer ? killer.name : '', final: false };
  ui.showRespawn(false);
  ui.showKillcam(true, {
    title: 'Killcam',
    subject: killcam.name,
    weapon: WEAPON_NAME,
    headshot: !!lastHitOn(player.entity)?.headshot,
    skippable: true,
    progress: 0,
    timeLeft: match.timeLeft,
  });
}

// The run-up to the match-winning kill, plus its aftermath. Nobody skips this one.
function startFinalKillcam(result) {
  pendingResult = result;
  if (killcam) { replay.stop(); killcam = null; }
  ui.showRespawn(false);

  const kill = lastKill;
  const started = kill && replay.start({
    victim: kill.victim,
    killer: kill.killer,
    duration: FINAL_KILLCAM_SECONDS + POST_KILL_SECONDS,
    endAt: kill.time + POST_KILL_SECONDS,
    elapsed: simTime,
    entities: match.entities,
    mode: 'final',
  });

  if (!started) { showResults(); return; }

  const killerName = kill.killer?.isPlayer ? 'you' : kill.killer?.name ?? '';
  killcam = { killer: kill.killer, name: killerName, final: true };
  ui.showKillcam(true, {
    title: 'Final Kill',
    subject: killerName,
    weapon: WEAPON_NAME,
    headshot: !!kill.headshot,
    skippable: false,
    progress: 0,
    timeLeft: match.timeLeft,
  });
}

function endKillcam() {
  if (!killcam) return;
  const wasFinal = killcam.final;
  replay.stop();
  killcam = null;
  ui.showKillcam(false);
  if (wasFinal) { showResults(); return; }
  if (match && !match.over) match.respawn(player.entity);
}

function showResults() {
  if (!pendingResult) return;
  ui.showMatchOver(true, pendingResult.title, pendingResult.detail, match?.scoreboardModel());
  reportResult(pendingResult);
  pendingResult = null;
  document.exitPointerLock?.();
}

// The arcade awards XP for every finished game, but this one runs inside an iframe with
// no server simulating it — so the result has to travel outward. ONE message per match,
// which the parent (components/PugShooter/PugShooterPlay.tsx) hands to the stats
// endpoint; that endpoint clamps and daily-caps it, because a result nobody simulated
// cannot be verified. It buys XP only — never rank.
//
// `matchStartedAt` is stamped by startMatch and cleared here, so a match reports once.
function reportResult(result) {
  if (window.parent === window || !matchStartedAt) return;
  const startedAt = matchStartedAt;
  matchStartedAt = 0;
  const rows = match?.scoreboardRows?.() ?? [];
  const mine = rows.find((r) => r.isPlayer);
  window.parent.postMessage({
    type: RESULT_MESSAGE,
    won: !!result?.won,
    kills: mine?.kills ?? 0,
    deaths: mine?.deaths ?? 0,
    score: mine?.score ?? 0,
    // The scoreboard is already sorted best-first, so the player's index in it
    // IS their placement.
    placement: mine ? rows.indexOf(mine) + 1 : null,
    durationMs: Date.now() - startedAt,
    roundId: String(startedAt),
  }, window.location.origin);
}

async function startMatch(mode, mapId = world.mapId, difficulty = DEFAULT_DIFFICULTY) {
  await loadMap(mapId);

  match = createMatch({
    difficulty,
    mode,
    scene: world.scene,
    collision,
    combat,
    player,
    ui,
    onFinish: (result) => queueCam({ kind: 'final', result }),
    onKillLogged: noteKill,
  });
  // built before the opening spawn, so that spawn arms Revenge like any other
  achievements = createAchievements({ playerEntity: player.entity, entities: match.entities });
  match.start();

  streak = 0;
  killcam = null;
  pendingCam = null;
  lastKill = null;
  pendingResult = null;
  matchStartedAt = Date.now();
  replay.clear();
  ui.showKillcam(false);
  ui.dismissOptions();
  ui.setMapCredit(world.config.credit);
  ui.showHud(true);
  ui.showMatchOver(false);
  ui.showLoading(false);      // the boot holds the loading screen until the match is live
  player.setEnabled(true);
  running = true;
  paused = false;
  requestPointerLock();
}

function requestPointerLock() {
  // The match-start call has no user gesture behind it (Play was clicked in the parent
  // frame), so the request may reject or throw — the mousedown listener below captures
  // the mouse on the player's first click instead.
  try {
    world.renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
  } catch {
    /* no gesture yet — first click will lock */
  }
}

// clicking the view re-captures the mouse after alt-tabbing away
document.addEventListener('mousedown', () => {
  if (running && !paused && !match?.over && !document.pointerLockElement) requestPointerLock();
});

function resume() {
  ui.showPause(false);
  paused = false;
  player.setEnabled(true);
  requestPointerLock();
}

// Drop the current match and everything hanging off it. Shared by "quit to menu" and
// "rematch" — the only difference is what gets started afterwards.
function teardownMatch() {
  if (killcam) { replay.stop(); killcam = null; }
  pendingCam = null;
  pendingResult = null;
  replay.clear();
  ui.showKillcam(false);
  ui.showRespawn(false);
  ui.showScoreboard(false);
  ui.clearNameplates();
  ui.clearDamageNumbers();
  ui.resetKillPoints();
  ui.clearGlows();
  achievements = null;

  if (match) {
    for (const bot of match.bots) {
      bot.character.dispose();
      collision.releaseCapsule(bot);
    }
    match = null;
  }
}

// Quit lands in the arcade lobby, which lives in the parent frame: tear the match down,
// then hand control back. Opened standalone (serve.py dev) there is no parent to return
// to, so reload into a fresh default match instead.
function exitToLobby() {
  running = false;
  paused = false;
  teardownMatch();
  ui.showPause(false);
  ui.dismissOptions();
  ui.showHud(false);
  ui.showMatchOver(false);
  player.setEnabled(false);
  document.exitPointerLock?.();
  if (window.parent !== window) window.parent.postMessage({ type: EXIT_MESSAGE }, '*');
  else location.reload();
}

// Straight into another round of the same mode, without a detour through the lobby.
function rematch() {
  const mode = match?.mode;
  const difficulty = match?.difficulty;
  teardownMatch();
  // same mode, same map, same difficulty — startMatch clears the results screen on its way in
  if (mode) startMatch(mode, world.mapId, difficulty).catch(onLoadFailure);
  else exitToLobby();
}

function onLoadFailure(err) {
  console.error(err);
  ui.setProgress('failed to load — see console', 1);
  ui.showLoading(true);
}

let hadPointerLock = false;
document.addEventListener('pointerlockchange', () => {
  if (!running) return;
  if (document.pointerLockElement) { hadPointerLock = true; return; }
  // only treat losing the mouse as a pause if we actually had it (Esc during play).
  // Never during a killcam — the blurred pause panel would cover the replay.
  if (hadPointerLock && !paused && !killcam && !match?.over) {
    paused = true;
    player.setEnabled(false);
    ui.showPause(true);
  }
  hadPointerLock = false;
});

document.addEventListener('keydown', (e) => {
  // the final kill plays out in full; only regular killcams can be skipped
  if (e.code === 'Space' && killcam && !killcam.final) { e.preventDefault(); endKillcam(); return; }
  if (e.code === 'Tab' && running && match) {
    e.preventDefault();
    ui.showScoreboard(true);
    ui.updateScoreboard(match.scoreboardModel());
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Tab') ui.showScoreboard(false);
});

// Where the shot actually goes, in screen pixels. Recoil rotates the camera but not the
// aim, so the crosshair slides to stay parked on the bullet's path.
const _aimPoint = new THREE.Vector3();
function crosshairOffset() {
  return project(player.aimPoint(_aimPoint));
}

// The killcam is the killer's screen, so the crosshair is theirs too: project the aim
// point the replay reconstructed for them. Null while the cam is orbiting a body with
// nobody to follow — there's no aim to draw.
function killcamCrosshairOffset() {
  return replay.aimPoint(_aimPoint) ? project(_aimPoint) : null;
}

// screen offset from centre, or null when the point isn't on screen at all — better no
// crosshair than one parked hundreds of pixels past the edge of the view
function project(point) {
  point.project(world.camera);
  if (point.z > 1 || Math.abs(point.x) > 1.05 || Math.abs(point.y) > 1.05) return null;
  return [point.x * 0.5 * window.innerWidth, -point.y * 0.5 * window.innerHeight];
}

function loop() {
  requestAnimationFrame(loop);
  step(Math.min(clock.getDelta(), 0.05), clock.elapsedTime);
  world.composer.render();
}

function step(dt, elapsed) {
  simTime += dt;
  collision.update();          // keeps Rapier's query pipeline current

  if (running && !paused && match && killcam) {
    // killcam owns the camera and every character transform until it finishes.
    // The crosshair stays on the killer's aim — you're watching their screen.
    const progress = replay.update(dt);
    ui.updateKillcamProgress(progress ?? 1);
    ui.setKillcamTime(match.timeLeft);
    const camAim = killcamCrosshairOffset();
    ui.showCrosshair(!!camAim);
    if (camAim) ui.updateCrosshair(0, ...camAim);
    ui.showRespawn(false);          // the cam owns the screen; no death overlay over it
    if (progress === null || progress >= 1) endKillcam();
  } else if (running && !paused && match) {
    player.update(dt, match.entities);
    // a cam waiting its turn keeps the world alive past the final whistle, so the
    // aftermath of the winning kill is recorded rather than frozen
    match.update(dt, !!pendingCam);
    replay.record(dt, match.entities, simTime);

    if (match.over && document.pointerLockElement) document.exitPointerLock?.();

    const aim = crosshairOffset();
    ui.showCrosshair(!!aim);
    if (aim) ui.updateCrosshair(player.state.adsAmount, ...aim);
    ui.updateNameplates(match.entities, world.camera, player.entity);
    ui.updateHud({
      health: player.entity.health,
      kills: player.entity.kills,
      ammo: player.state.ammo,
      reserve: player.state.reserve,
      magSize: player.magSize,
      reloading: player.state.reloading > 0,
      reloadFrac: player.reloadFraction,
      speed: player.state.speed,
      bhopChain: player.state.bhopChain,
      bhopLocked: player.bhopLocked,
      scoreText: match.scoreText(),
      leaderboard: match.scoreboardRows(),
      minimap: { entities: match.entities, playerEntity: player.entity, bounds: collision.bounds },
    });
    // player.update() above can kill you and open a killcam mid-frame — don't slap the
    // death overlay back over it on the way out, nor over the seconds we're still
    // filming before one starts
    ui.showRespawn(!player.entity.alive && !killcam && !pendingCam, player.state.respawnTimer);

    // ...and once those seconds are banked, roll the cam
    if (pendingCam) {
      pendingCam.timer -= dt;
      if (pendingCam.timer <= 0) {
        const cam = pendingCam;
        pendingCam = null;
        if (cam.kind === 'final') startFinalKillcam(cam.result);
        else startKillcam(cam.killer);
      }
    }
  }

  combat.update(dt);
  ui.tick(dt, world.camera);
  audio.updateListener(world.camera);

  hurt = Math.max(0, hurt - dt * 2.6);
  world.gradePass.uniforms.uHurt.value = hurt * 0.85;

  world.sky.position.copy(world.camera.position);
  world.sky.tick(elapsed);
  world.grass?.tick(elapsed);      // interiors have none
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('loading-label').textContent = 'failed to load — see console';
});

export { MODES };
