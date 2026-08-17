// Neon Clumsy - main orchestration: boot, input, round flow, fixed-timestep
// simulation, bumps, eliminations, camera, HUD.
import * as THREE from "three";
import * as RAPIER from "./vendor/rapier.js";
import { CFG } from "./config.js";
import { STR } from "./strings.js";
import { UI } from "./ui.js";
import { AudioSys } from "./audio.js";
import { Level } from "./level.js";
import { loadCharacterTemplate, Character } from "./character.js";
import { Pawn, PSTATE } from "./pawn.js";
import { BotBrain } from "./bots.js";
import { RagdollSystem } from "./ragdoll.js";

// ---------- seeded rng ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEP = 1 / 60;
const touchMode = ("ontouchstart" in window) && navigator.maxTouchPoints > 0;
const bootParams = new URLSearchParams(location.search);
const devMode = bootParams.has("dev");

// ---------- embedded autostart ----------
// The arcade only mounts this game once the player has ALREADY committed to a
// round: they pressed PRACTICE, their WAGER MATCH queue found an opponent, or a
// PRIVATE WAGER lobby finished readying up. Pressing PLAY again is a second menu
// for a decision already made, so `?autostart=1` boots straight into the
// countdown and `&name=` carries the arcade profile name that the old nickname
// field used to ask for. The menu screen itself is left intact — it is simply
// never shown in the embed.
const autoStart = bootParams.get("autostart") === "1";
const bootNick = (bootParams.get("name") || "").trim().slice(0, 14);

const ui = new UI();
const audio = new AudioSys();

// ---------- renderer / scene ----------
const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
if (CFG.shadows && !touchMode) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(CFG.fogColor, 36, 130);
const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 400);

function resize() {
  // 0x0 happens when an embedded/background viewport collapses - keep last size
  const w = innerWidth || 1280, h = innerHeight || 720;
  const dpr = Math.min(devicePixelRatio || 1, touchMode ? CFG.dprCapMobile : CFG.dprCap);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
addEventListener("orientationchange", resize);
resize();

// ---------- game state ----------
let world = null, level = null, template = null, rags = null;
let pawns = [], brains = new Map(), player = null;
let elims = [];        // { rag, pawn, splat, age }
let recoveries = [];   // { rag, pawn, t }
let mode = "LOADING";  // LOADING MENU COUNTDOWN PLAYING ENDED
let countdownT = 0, roundTime = 0, aliveCount = 0, endDelay = -1, playerEndDelay = -1;
let winner = null, playerPlace = 0, rng = mulberry32(1);
let specTarget = null;
let paused = false;
let playerDeathPos = null;   // Vector3 of the player's ragdoll hips

// ---------- input ----------
const keys = new Set();
let camYaw = 0, camPitch = -0.32, camDist = CFG.camDist;
let mouseDX = 0, yawVelSmooth = 0;
let pendingJump = false, pendingDive = false;
const padPrev = { jump: false, dive: false };
const stick = { x: 0, y: 0, active: false, id: -1 };
const touchBtn = { jump: false, dive: false, sprint: false };
let lookTouch = { id: -1, x: 0, y: 0 };

addEventListener("keydown", (e) => {
  if (e.code === "Escape") return;
  if (document.activeElement === ui.els.nick) return;
  keys.add(e.code);
  if (e.code === "Space" && !e.repeat && mode === "PLAYING" && player.alive) {
    if (player.grounded) pendingJump = true;
    else pendingDive = true;
  }
  if (["Space", "ArrowUp", "ArrowDown"].includes(e.code)) e.preventDefault();
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => { if (mode === "PLAYING") setPaused(true); });

document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === canvas;
  if (!locked && mode === "PLAYING" && !touchMode && player.alive && !paused) {
    setPaused(true);
  }
  ui.show("lockOverlay", false);
});
addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  mouseDX += e.movementX;
  camYaw -= e.movementX * CFG.mouseSens;
  camPitch = Math.max(CFG.camPitchMin, Math.min(CFG.camPitchMax,
    camPitch - e.movementY * CFG.mouseSens));
});
canvas.addEventListener("click", () => {
  // COUNTDOWN is included for the embedded autostart: the round now begins
  // without the click that PLAY used to provide, so the 3-2-1 is the window in
  // which the player's first click has to be able to grab the mouse.
  if ((mode === "PLAYING" || mode === "COUNTDOWN") && !touchMode &&
      !document.pointerLockElement && player.alive && !paused) {
    canvas.requestPointerLock();
  } else if (mode === "PLAYING" && !player.alive && specTarget) {
    cycleSpectate();
  } else if (mode === "ENDED" && specTarget) {
    cycleSpectate();
  }
});

function requestLock() {
  if (touchMode) return;
  // Pointer lock needs user activation. A freshly-created iframe has none, so
  // the autostart call below is EXPECTED to be refused — swallow both the throw
  // and the rejected promise, and let the canvas click above do the real work.
  try {
    const p = canvas.requestPointerLock();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) {}
}

/**
 * Recover the two things a round normally inherits from the PLAY click, on the
 * player's first interaction with the embedded frame instead: the AudioContext
 * (created suspended without user activation) and the music loop. Pointer lock
 * is deliberately NOT taken here — that would steal the cursor from clicks on
 * the mute button; the canvas handler above owns it.
 */
function armEmbedActivation() {
  const activate = () => {
    audio.resume();
    audio.playMusic();
    if (audio.ctx && audio.ctx.state !== "suspended") {
      removeEventListener("pointerdown", activate, true);
      removeEventListener("keydown", activate, true);
    }
  };
  addEventListener("pointerdown", activate, true);
  addEventListener("keydown", activate, true);
}

// touch controls
if (touchMode) {
  const base = ui.els.touchUI.querySelector("#stickBase");
  const knob = base.querySelector("#stickKnob");
  const onStick = (e) => {
    for (const t of e.changedTouches) {
      if (stick.id === -1 && e.type === "touchstart") stick.id = t.identifier;
      if (t.identifier !== stick.id) continue;
      const r = base.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = (t.clientX - cx) / (r.width / 2), dy = (t.clientY - cy) / (r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      stick.x = dx; stick.y = dy; stick.active = true;
      knob.style.transform = `translate(${dx * 34}px, ${dy * 34}px)`;
    }
    e.preventDefault();
  };
  const offStick = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stick.id) {
        stick.id = -1; stick.x = stick.y = 0; stick.active = false;
        knob.style.transform = "translate(0,0)";
      }
    }
    e.preventDefault();
  };
  base.addEventListener("touchstart", onStick, { passive: false });
  base.addEventListener("touchmove", onStick, { passive: false });
  base.addEventListener("touchend", offStick, { passive: false });
  base.addEventListener("touchcancel", offStick, { passive: false });

  canvas.addEventListener("touchstart", (e) => {
    for (const t of e.changedTouches) {
      if (t.clientX > innerWidth * 0.4 && lookTouch.id === -1) {
        lookTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
      }
    }
  }, { passive: true });
  canvas.addEventListener("touchmove", (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== lookTouch.id) continue;
      camYaw -= (t.clientX - lookTouch.x) * 0.006;
      camPitch = Math.max(CFG.camPitchMin, Math.min(CFG.camPitchMax,
        camPitch - (t.clientY - lookTouch.y) * 0.006));
      lookTouch.x = t.clientX; lookTouch.y = t.clientY;
    }
  }, { passive: true });
  canvas.addEventListener("touchend", (e) => {
    for (const t of e.changedTouches) if (t.identifier === lookTouch.id) lookTouch.id = -1;
  }, { passive: true });

  ui.els.btnJump.addEventListener("touchstart", (e) => {
    e.preventDefault();
    if (player && player.alive && mode === "PLAYING") {
      if (player.grounded) pendingJump = true; else pendingDive = true;
    }
  }, { passive: false });
  ui.els.btnDive.addEventListener("touchstart", (e) => {
    e.preventDefault();
    if (player && player.alive && mode === "PLAYING" && !player.grounded) pendingDive = true;
  }, { passive: false });
  ui.els.btnSprint.addEventListener("touchstart", (e) => {
    e.preventDefault();
    touchBtn.sprint = !touchBtn.sprint;
    ui.els.btnSprint.classList.toggle("on", touchBtn.sprint);
  }, { passive: false });
}

function pollPad() {
  const out = { mx: 0, my: 0, lookX: 0, lookY: 0, sprint: false, jump: false, dive: false };
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    const dz = (v) => Math.abs(v) > 0.18 ? v : 0;
    out.mx += dz(gp.axes[0] || 0);
    out.my += dz(gp.axes[1] || 0);
    out.lookX += dz(gp.axes[2] || 0);
    out.lookY += dz(gp.axes[3] || 0);
    const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    out.sprint = out.sprint || b(5) || b(4) || b(7);
    const j = b(0), d = b(2) || b(1);
    if (j && !padPrev.jump) { if (player.grounded) out.jump = true; else out.dive = true; }
    if (d && !padPrev.dive) out.dive = true;
    padPrev.jump = j; padPrev.dive = d;
  }
  return out;
}

function playerInput(dt) {
  const pad = pollPad();
  camYaw -= pad.lookX * CFG.padLookSpeed * dt;
  camPitch = Math.max(CFG.camPitchMin, Math.min(CFG.camPitchMax,
    camPitch - pad.lookY * CFG.padLookSpeed * dt));

  const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
  const rx = -fz, rz = fx;
  let ix = 0, iz = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) { ix += fx; iz += fz; }
  if (keys.has("KeyS") || keys.has("ArrowDown")) { ix -= fx; iz -= fz; }
  if (keys.has("KeyD") || keys.has("ArrowRight")) { ix += rx; iz += rz; }
  if (keys.has("KeyA") || keys.has("ArrowLeft")) { ix -= rx; iz -= rz; }
  ix += fx * -pad.my + rx * pad.mx;
  iz += fz * -pad.my + rz * pad.mx;
  if (stick.active) {
    ix += fx * -stick.y + rx * stick.x;
    iz += fz * -stick.y + rz * stick.x;
  }
  const len = Math.hypot(ix, iz);
  if (len > 1) { ix /= len; iz /= len; }

  // smoothed yaw velocity drives the sprint-turn animations
  // (mouse right -> positive dx -> visual right turn -> SprintTurnR)
  const yawVel = mouseDX / Math.max(dt, 1e-4);
  mouseDX = 0;
  yawVelSmooth += (yawVel - yawVelSmooth) * Math.min(1, dt * 10);
  const yawRate = yawVelSmooth * CFG.mouseSens;
  const turnDir = yawRate > CFG.yawTurnAnimThreshold ? 1
    : yawRate < -CFG.yawTurnAnimThreshold ? -1 : 0;

  const input = {
    mx: ix, mz: iz,
    sprint: keys.has("ShiftLeft") || keys.has("ShiftRight") || pad.sprint || touchBtn.sprint,
    jump: pendingJump || pad.jump,
    dive: pendingDive || pad.dive,
    turnDir,
  };
  pendingJump = pendingDive = false;
  return input;
}

// ---------- boot ----------
async function boot() {
  ui.show("loading", true);
  let prog = 0;
  const bump = (k) => { prog = Math.max(prog, k); ui.loadingProgress(prog); };
  try {
    bump(0.05);
    await RAPIER.init();
    bump(0.2);
    world = new RAPIER.World({ x: 0, y: CFG.ragGravity, z: 0 });
    world.timestep = STEP;
    rags = new RagdollSystem(RAPIER, world);

    level = new Level(scene, RAPIER, world, {
      onCrumble: (pos) => {
        audio.sfx("crumble", { rate: 0.92 + Math.random() * 0.2 });
      },
    });
    level.setBillboardTexts([STR.billboard1, STR.billboard2, STR.billboard3]);
    level.build();
    bump(0.45);

    template = await loadCharacterTemplate((k) => bump(0.45 + k * 0.35));
    bump(0.8);
    await audio.load();
    bump(1);

    buildPawns();
    spawnAll();          // menu diorama: mummies idle on the top layer
    mode = "MENU";
    if (autoStart) {
      // Straight into the countdown — no menu, no second PLAY press. The nick
      // field is still what ui.nickname() reads (feed + end screen), so seed it
      // from the arcade profile before the round starts.
      if (bootNick) ui.els.nick.value = bootNick;
      ui.show("loading", false);
      armEmbedActivation();
      startRound();
    } else {
      ui.showMenu();
      menuCamera(0);
    }
  } catch (err) {
    console.error("boot failed:", err);
    ui.loadingFailed();
  }
}

function buildPawns() {
  const seed = (Date.now() & 0xffff) ^ 0x9e37;
  rng = mulberry32(seed);
  const names = [...STR.botNames];
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }

  const playerChar = new Character(template, { isPlayer: true });
  playerChar.group.traverse((o) => {
    if (o.isSkinnedMesh) {
      o.material.emissive = new THREE.Color(0x0a4438); // subtle mint rim-feel
      o.material.emissiveIntensity = 0.55;
    }
  });
  scene.add(playerChar.group);
  player = new Pawn(playerChar, level, { name: "you", isPlayer: true });
  player.onJump = () => audio.sfx("jump", { rate: 0.95 + Math.random() * 0.1 });
  player.onDive = () => audio.sfx("dive");
  pawns.push(player);

  const tiers = [];
  CFG.botTiers.forEach((t, ti) => { for (let i = 0; i < t.n; i++) tiers.push(t); });
  for (let i = 0; i < CFG.players - 1; i++) {
    const hue = (i / (CFG.players - 1) + 0.03) % 1;
    const tint = new THREE.Color().setHSL(hue, 0.55, 0.72);
    const tagColor = "#" + new THREE.Color().setHSL(hue, 0.9, 0.72).getHexString();
    const ch = new Character(template, { tint, name: names[i], tagColor });
    scene.add(ch.group);
    const pawn = new Pawn(ch, level, { name: names[i] });
    pawn.onJump = () => {};
    pawns.push(pawn);
    const tier = tiers[i % tiers.length];
    brains.set(pawn, new BotBrain(pawn, tier, level, mulberry32(seed + i * 977)));
  }
}

// ---------- round flow ----------
function spawnAll() {
  const topY = level.layerTopY(CFG.layers - 1);
  for (let i = 0; i < pawns.length; i++) {
    const a = (i / pawns.length) * Math.PI * 2 + 0.3;
    const x = Math.cos(a) * CFG.spawnRingRadius;
    const z = Math.sin(a) * CFG.spawnRingRadius;
    pawns[i].spawnAt(x, topY, z, Math.atan2(-x, -z));
  }
}

function startRound() {
  audio.resume();
  audio.playMusic();
  level.reset();
  for (const rag of [...rags.list]) rags.release(rag);
  elims = []; recoveries = [];
  winner = null; endDelay = -1; playerEndDelay = -1;
  roundTime = 0; aliveCount = CFG.players;
  roundStartedAt = Date.now();   // arms the XP report (see reportResult)
  specTarget = null;
  playerDeathPos = null;
  ui.spectating(null);

  spawnAll();
  camYaw = Math.atan2(player.pos.x, player.pos.z);
  camPitch = -0.36;
  camDist = 11;

  mode = "COUNTDOWN";
  countdownT = 0;
  ui.startRound();
  ui.setPlayersLeft(aliveCount);
  ui.setTimer(0);
  if (touchMode) ui.els.touchUI.style.display = "block";
  requestLock();
}

function eliminate(pawn) {
  if (!pawn.alive) return;
  pawn.die();
  aliveCount--;
  ui.setPlayersLeft(aliveCount);
  ui.feed(pawn.isPlayer ? ui.nickname() : pawn.name);
  audio.sfx("crowd", { throttle: 0.6 });
  const rag = rags.spawn(pawn.character, pawn.vel);
  elims.push({ rag, pawn, splat: false, age: 0 });

  if (pawn.isPlayer) {
    playerPlace = aliveCount + 1;
    playerEndDelay = 1.15;
  }
  if (aliveCount <= 1 && endDelay < 0) {
    winner = pawns.find((p) => p.alive) || pawn;
    endDelay = 1.35;
  }
}

// ── progression ────────────────────────────────────────────────────────────
// The arcade awards XP for every finished game, but this one runs inside an
// iframe with no server behind it, so the result has to travel outward: ONE
// message when the player's round is over, which the parent
// (components/Clumsy/ClumsyPlay.tsx) hands to the stats endpoint. That endpoint
// clamps and daily-caps it — an unverifiable result is worth XP, never rank.
//
// Both endings funnel through here (winning the round, and being eliminated
// before it ends), and `roundStartedAt` is cleared on the way so a round can
// only ever report once.
let roundStartedAt = 0;
function reportResult(win) {
  if (window.parent === window || !roundStartedAt) return;
  const startedAt = roundStartedAt;
  roundStartedAt = 0;
  window.parent.postMessage({
    type: "neon-clumsy:result",
    won: !!win,
    // Tiles claimed is the game's own score. Bumps are not kills — nobody
    // dies in Clumsy — so the arcade records no K/D for it.
    tiles: player.stats.tiles,
    place: win ? 1 : (playerPlace || null),
    total: CFG.players,
    durationMs: Date.now() - startedAt,
    roundId: String(startedAt),
  }, window.location.origin);
}

function roundEnd() {
  mode = "ENDED";
  document.exitPointerLock && document.exitPointerLock();
  if (touchMode) ui.els.touchUI.style.display = "none";
  const win = winner === player;
  if (win) {
    level.confetti(player.pos.x, player.pos.y, player.pos.z);
    audio.sfx("crowd", { vol: 0.6, throttle: 0 });
    ui.showEnd({ win: true, stats: player.stats });
  } else {
    ui.showEnd({
      win: false,
      winnerName: winner && !winner.isPlayer ? winner.name : null,
      place: playerPlace || 2, total: CFG.players, stats: player.stats,
    });
  }
  reportResult(win);
}

function playerEliminatedScreen() {
  if (mode !== "PLAYING") return;
  document.exitPointerLock && document.exitPointerLock();
  if (touchMode) ui.els.touchUI.style.display = "none";
  ui.showEnd({ win: false, place: playerPlace, total: CFG.players, stats: player.stats });
  // The player's round is over even though the match runs on for the
  // spectators — award it now rather than depending on them watching to the
  // end. reportResult() self-disarms, so roundEnd() will not double it.
  reportResult(false);
}

function startSpectate() {
  ui.show("end", false);
  specTarget = pawns.find((p) => p.alive && p !== player) || null;
  ui.spectating(specTarget ? specTarget.name : null);
}

function cycleSpectate() {
  const alive = pawns.filter((p) => p.alive && p !== player);
  if (!alive.length) return;
  const i = alive.indexOf(specTarget);
  specTarget = alive[(i + 1) % alive.length];
  ui.spectating(specTarget.name);
}

function setPaused(v) {
  if (mode !== "PLAYING" && mode !== "COUNTDOWN") return;
  paused = v;
  ui.show("pause", v);
  if (!v) requestLock();
}

// ---------- bumps ----------
const _n = new THREE.Vector3();
function resolveBumps() {
  for (let i = 0; i < pawns.length; i++) {
    const a = pawns[i];
    if (!a.alive || a.state === PSTATE.RAGDOLL || a.state === PSTATE.DEAD) continue;
    for (let j = i + 1; j < pawns.length; j++) {
      const b = pawns[j];
      if (!b.alive || b.state === PSTATE.RAGDOLL || b.state === PSTATE.DEAD) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const dy = Math.abs(b.pos.y - a.pos.y);
      if (dy > 1.3) continue;
      const d = Math.hypot(dx, dz);
      const minD = CFG.charRadius * 2;
      if (d >= minD || d < 1e-5) continue;
      const nx = dx / d, nz = dz / d;
      const push = (minD - d) / 2;
      if (a.state !== PSTATE.FROZEN) { a.pos.x -= nx * push; a.pos.z -= nz * push; }
      if (b.state !== PSTATE.FROZEN) { b.pos.x += nx * push; b.pos.z += nz * push; }

      // trip check: attacker = the one moving faster into the contact
      const va = a.vel.x * nx + a.vel.z * nz;          // a toward b
      const vb = -(b.vel.x * nx + b.vel.z * nz);       // b toward a
      let attacker = null, victim = null, dirx = 0, dirz = 0, closing = 0;
      if (va > vb && va > CFG.bumpTripSpeed) {
        attacker = a; victim = b; dirx = nx; dirz = nz; closing = va;
      } else if (vb > va && vb > CFG.bumpTripSpeed) {
        attacker = b; victim = a; dirx = -nx; dirz = -nz; closing = vb;
      }
      if (!attacker) continue;
      const strong = closing > CFG.sprintSpeed * 0.9 && rng() < 0.4;
      const impulse = {
        x: dirx * CFG.bumpImpulse, y: CFG.bumpUpImpulse * 0.6, z: dirz * CFG.bumpImpulse,
      };
      const res = victim.applyBump(impulse, strong);
      if (res === "ragdoll") {
        victim.state = PSTATE.RAGDOLL;
        const rag = rags.spawn(victim.character, victim.vel, {
          impulse: { x: dirx * CFG.ragdollImpulseThreshold, y: 2.6, z: dirz * CFG.ragdollImpulseThreshold },
        });
        recoveries.push({ rag, pawn: victim, t: CFG.ragdollRecoverTime });
        attacker.stats.bumps++;
        attacker.vel.x *= 0.45; attacker.vel.z *= 0.45;
      } else if (res === "trip") {
        attacker.stats.bumps++;
        attacker.vel.x *= 0.5; attacker.vel.z *= 0.5;
      }
    }
  }
}

// ---------- fixed-step sim ----------
let goHide = 0;
function simTick(dt) {
  if (mode === "COUNTDOWN") {
    countdownT += dt;
    const left = CFG.countdownTime - countdownT;
    if (left > 2.4) ui.countdown(STR.countdown3);
    else if (left > 1.4) ui.countdown(STR.countdown2);
    else if (left > 0.4) ui.countdown(STR.countdown1);
    else {
      ui.countdown(STR.go);
      for (const p of pawns) p.unfreeze();
      mode = "PLAYING";
      goHide = 0.9;
    }
  }
  if (goHide > 0) { goHide -= dt; if (goHide <= 0) ui.countdown(null); }

  if (mode === "PLAYING" || mode === "ENDED" || mode === "COUNTDOWN") {
    if (mode === "PLAYING") roundTime += dt;

    // inputs
    const pin = (player.alive && mode !== "ENDED") ? playerInput(dt) : { mx: 0, mz: 0 };
    player.update(dt, pin);
    for (const [pawn, brain] of brains) {
      pawn.update(dt, brain.update(dt, pawns));
    }

    resolveBumps();

    // eliminations
    for (const p of pawns) {
      if (p.alive && p.state !== PSTATE.RAGDOLL && p.pos.y < CFG.killY) eliminate(p);
    }

    // ragdoll recoveries (strong bumps)
    for (let i = recoveries.length - 1; i >= 0; i--) {
      const r = recoveries[i];
      r.t -= dt;
      const hips = rags.hipsOf(r.rag);
      if (hips && hips.y < CFG.killY) {
        rags.release(r.rag);
        recoveries.splice(i, 1);
        r.pawn.pos.set(hips.x, hips.y, hips.z);
        r.pawn.state = PSTATE.AIR;
        eliminate(r.pawn);
        continue;
      }
      if (r.t <= 0) {
        recoveries.splice(i, 1);
        if (hips) {
          rags.release(r.rag);
          r.pawn.recoverAt(hips.x, hips.y - CFG.charHeight * 0.5, hips.z);
        }
      }
    }

    // elimination ragdolls: splash + cleanup
    for (let i = elims.length - 1; i >= 0; i--) {
      const e = elims[i];
      e.age += dt;
      const hips = rags.hipsOf(e.rag);
      if (hips && e.pawn.isPlayer && hips.y > CFG.slimeY - 0.6) {
        // track the splat but never follow the body under the slime
        if (!playerDeathPos) playerDeathPos = new THREE.Vector3();
        playerDeathPos.set(hips.x, Math.max(hips.y, CFG.slimeY + 0.4), hips.z);
      }
      if (!e.splat && hips && hips.y < CFG.slimeY + 0.3) {
        e.splat = true;
        level.splash(hips.x, hips.z);
        audio.sfx("splat", { rate: 0.92 + Math.random() * 0.16 });
      }
      if (e.age > 2.8) {
        rags.release(e.rag);
        e.pawn.character.group.visible = false;
        elims.splice(i, 1);
      }
    }

    world.step();
    rags.update(dt);

    if (playerEndDelay > 0) {
      playerEndDelay -= dt;
      if (playerEndDelay <= 0 && mode === "PLAYING") playerEliminatedScreen();
    }
    if (endDelay > 0) {
      endDelay -= dt;
      if (endDelay <= 0 && mode !== "ENDED") roundEnd();
    }
  }

  level.update(dt, perfNow() / 1000);
  for (const p of pawns) p.character.update(dt);
}

function perfNow() { return performance.now(); }

// ---------- camera ----------
const camTargetV = new THREE.Vector3(), camPosV = new THREE.Vector3();
function updateCamera(dt) {
  if (mode === "MENU" || mode === "LOADING") { menuCamera(dt); return; }
  if (mode === "COUNTDOWN") {
    camDist += (CFG.camDist - camDist) * Math.min(1, dt * 1.6);
    camYaw += dt * 0.25;
  }
  // camera direction is mouse-owned: no auto-follow, the player decides
  let t;
  if (player.alive) {
    t = player.character.group.position;
  } else if (specTarget && specTarget.alive) {
    t = specTarget.character.group.position;
  } else if (specTarget && !specTarget.alive) {
    cycleSpectate();
    t = specTarget && specTarget.alive ? specTarget.character.group.position
      : (playerDeathPos || player.character.group.position);
  } else {
    t = playerDeathPos || player.character.group.position;
  }
  camTargetV.set(t.x, t.y + CFG.camHeight, t.z);
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  camPosV.set(
    camTargetV.x + Math.sin(camYaw) * cp * camDist,
    camTargetV.y + -sp * camDist,
    camTargetV.z + Math.cos(camYaw) * cp * camDist);
  if (camPosV.y < CFG.slimeY + 0.5) camPosV.y = CFG.slimeY + 0.5;
  const k = Math.min(1, CFG.camLerp * dt);
  camera.position.lerp(camPosV, mode === "COUNTDOWN" ? Math.min(1, dt * 3) : k);
  camera.lookAt(camTargetV);
}

let menuA = 0;
function menuCamera(dt) {
  menuA += dt * 0.12;
  const r = 26;
  camera.position.set(Math.cos(menuA) * r, 14 + Math.sin(menuA * 0.7) * 2, Math.sin(menuA) * r);
  camera.lookAt(0, 8, 0);
}

// ---------- HUD ----------
let hudT = 0;
function updateHUD(dt) {
  hudT -= dt;
  if (hudT > 0) return;
  hudT = 0.12;
  if (mode === "PLAYING" || mode === "COUNTDOWN") {
    ui.setPlayersLeft(aliveCount);
    const ref = player.alive ? player : specTarget;
    if (ref) {
      const L = ref.grounded ? ref.layer
        : Math.max(0, Math.min(CFG.layers - 1, Math.floor(ref.pos.y / CFG.layerGap)));
      ui.setLayer(L + 1, CFG.layers);
    }
    ui.setTimer(roundTime);
  }
}

// ---------- dev overlay ----------
let devFrames = 0, devAt = 0, devFps = 0;
function updateDev(now) {
  if (!devMode) return;
  devFrames++;
  if (now - devAt >= 500) {
    devFps = Math.round(devFrames * 1000 / (now - devAt));
    devFrames = 0; devAt = now;
    ui.els.dev.style.display = "block";
    ui.els.dev.textContent =
      `${devFps} fps | calls ${renderer.info.render.calls} | tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k` +
      ` | tiles ${level.totalAlive()} | rag bodies ${rags.activeBodies} | pawns ${aliveCount}`;
  }
}

// ---------- main loop ----------
let acc = 0, last = perfNow();
function frame(now) {
  requestAnimationFrame(frame);
  let ft = now - last;
  last = now;
  if (paused || document.hidden) return;
  ft = Math.min(ft, 100);
  acc += ft;
  while (acc >= STEP * 1000) {
    simTick(STEP);
    acc -= STEP * 1000;
  }
  updateCamera(ft / 1000);
  updateHUD(ft / 1000);
  renderer.render(scene, camera);
  updateDev(now);
}

// ---------- ui wiring ----------
ui.bind({
  onPlay: () => { if (mode === "MENU") startRound(); },
  onAgain: () => { if (mode === "PLAYING" || mode === "ENDED") startRound(); },
  onSpectate: () => startSpectate(),
  onResume: () => setPaused(false),
  onMute: () => ui.setMuted(audio.toggleMute()),
});
addEventListener("keydown", (e) => {
  if (e.code === "Escape") {
    if (mode === "PLAYING" && !player.alive && specTarget) {
      specTarget = null;
      ui.spectating(null);
      ui.show("end", true);
    }
  }
});

// dev-only hooks (?dev=1): manual stepping for headless verification
if (devMode) {
  window.__NC = {
    play: () => startRound(),
    forceUnpause: () => { paused = false; ui.show("pause", false); },
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) simTick(STEP);
      updateCamera(STEP * n > 0.5 ? 0.5 : STEP * n);
      updateHUD(1);
      renderer.render(scene, camera);
      return window.__NC.info();
    },
    press: (code, down = true) =>
      dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code })),
    setCam: (yaw, pitch) => { camYaw = yaw; if (pitch !== undefined) camPitch = pitch; },
    info: () => ({
      mode, paused, alive: aliveCount, camYaw: +camYaw.toFixed(4),
      player: player ? {
        pos: player.pos.toArray().map((v) => +v.toFixed(2)),
        state: player.state, grounded: player.grounded, layer: player.layer,
        anim: player.character.current, alive: player.alive,
      } : null,
      calls: renderer.info.render.calls,
      tris: renderer.info.render.triangles,
      tiles: level ? level.totalAlive() : -1,
      rags: rags ? rags.list.size : -1,
    }),
  };
}

boot();
requestAnimationFrame(frame);
