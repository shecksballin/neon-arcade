// Howler-backed sound. Everything is positional except the player's own actions, so
// bot gunfire tells you where it came from.
//
// Absolute path: the arcade serves the shared asset pack from the web root, while the
// game itself lives one level down at /neon-pug-shooter/.
const DIR = '/neonpugshootercomponents/';

const CLIPS = {
  gun:        { src: 'gunsoundfx.mp3',            volume: 0.45, pool: 12 },
  headshot:   { src: 'headshotsoundfx.mp3',       volume: 0.85, pool: 3 },
  bodyKill:   { src: 'bodyShotKillSoundFx.mp3',   volume: 0.8,  pool: 3 },
  hitmarker:  { src: 'hitmarker.mp3',             volume: 0.6,  pool: 6 },
  reload:     { src: 'Reloadsoundfx.mp3',         volume: 0.75, pool: 3 },
};

const silent = {
  ready: false,
  reloadDuration: 0,
  playGun() {}, playHeadshot() {}, playBodyKill() {}, playKill() {}, playHitmarker() {},
  playReload() {},
  setVolume() {}, updateListener() {},
};

export async function createAudio({ volume = 0.7 } = {}) {
  let Howl, Howler;
  try {
    ({ Howl, Howler } = await import('howler'));
  } catch (err) {
    console.warn('howler failed to load — running silent', err);
    return silent;
  }

  Howler.volume(volume);
  // a shooter's audio should fall off with distance, but stay audible across a street
  Howler.pos(0, 0, 0);

  const sounds = {};
  for (const [name, cfg] of Object.entries(CLIPS)) {
    sounds[name] = new Howl({
      src: [DIR + cfg.src],
      volume: cfg.volume,
      pool: cfg.pool,
      html5: false,          // Web Audio, so panning works
      preload: true,
    });
  }

  // play at a world position; omit `at` for the player's own sounds (always centred)
  function play(name, at = null, { rate = 1, volumeScale = 1 } = {}) {
    const sound = sounds[name];
    if (!sound) return;
    const id = sound.play();
    if (rate !== 1) sound.rate(rate, id);
    if (volumeScale !== 1) sound.volume(CLIPS[name].volume * volumeScale, id);
    if (at) {
      sound.pos(at.x, at.y, at.z, id);
      sound.pannerAttr({ panningModel: 'HRTF', refDistance: 8, rolloffFactor: 0.9, distanceModel: 'inverse' }, id);
    }
    return id;
  }

  // camera's -Z axis in world space, straight off the matrix (no THREE import needed)
  const forward = { x: 0, y: 0, z: -1 };
  function readForward(camera) {
    const m = camera.matrixWorld.elements;
    const len = Math.hypot(m[8], m[9], m[10]) || 1;
    forward.x = -m[8] / len;
    forward.y = -m[9] / len;
    forward.z = -m[10] / len;
  }

  // The reload sound sets the length of the whole reload — the animation is retimed to it
  // and the mag lands on its last frame — so it has to be known before the first one.
  const reloadDuration = await new Promise((resolve) => {
    const sound = sounds.reload;
    if (sound.state() === 'loaded') { resolve(sound.duration()); return; }
    sound.once('load', () => resolve(sound.duration()));
    sound.once('loaderror', () => resolve(0));
  });

  return {
    ready: true,
    reloadDuration,

    // slight pitch variation so a held burst doesn't sound like a machine
    playGun(at = null) {
      play('gun', at, { rate: 0.94 + Math.random() * 0.12, volumeScale: at ? 1 : 0.85 });
    },
    playHeadshot() { play('headshot'); },
    playBodyKill() { play('bodyKill'); },
    // one call site for "you killed someone" — the sound depends on where you hit them
    playKill(headshot) { play(headshot ? 'headshot' : 'bodyKill'); },
    playHitmarker() { play('hitmarker'); },
    playReload() { play('reload'); },

    setVolume(v) { Howler.volume(v); },

    // keep the listener on the camera so panning matches what's on screen
    updateListener(camera) {
      const p = camera.position;
      Howler.pos(p.x, p.y, p.z);
      readForward(camera);
      Howler.orientation(forward.x, forward.y, forward.z, 0, 1, 0);
    },
  };
}
