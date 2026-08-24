/**
 * Tiny synthesized SFX — no audio assets shipped, everything is WebAudio.
 * Built lazily on the first user gesture so autoplay policies stay happy.
 */
let ctx: AudioContext | null = null;
let muted = false;

function ac(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function setMuted(m: boolean) {
  muted = m;
}

function noiseBuffer(c: AudioContext, seconds: number): AudioBuffer {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** referee whistle — two short high bursts */
export function whistle() {
  if (muted) return;
  const c = ac();
  for (const [at, len] of [
    [0, 0.14],
    [0.2, 0.26],
  ] as const) {
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.value = 2350;
    const vib = c.createOscillator();
    vib.frequency.value = 38;
    const vibGain = c.createGain();
    vibGain.gain.value = 120;
    vib.connect(vibGain).connect(o.frequency);
    const g = c.createGain();
    const t = c.currentTime + at;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
    g.gain.setValueAtTime(0.05, t + len - 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + len + 0.02);
    vib.start(t);
    vib.stop(t + len + 0.02);
  }
}

/** crowd — a filtered noise swell; brighter + longer for a roar, duller for a groan */
function crowd(seconds: number, freq: number, peak: number) {
  if (muted) return;
  const c = ac();
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, seconds);
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = freq;
  const g = c.createGain();
  const t = c.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + seconds * 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  src.connect(f).connect(g).connect(c.destination);
  src.start();
}

export function roar() {
  crowd(1.7, 2600, 0.35);
}

export function groan() {
  crowd(1.1, 700, 0.22);
}

// ---- recorded one-shots
//
// Everything above is synthesised, but some effects want a real recording. These
// are decoded once and kept, so firing one mid-round costs a buffer source and
// nothing else.
const samples = new Map<string, AudioBuffer>();
const loading = new Set<string>();

/**
 * Silence welded onto the front of a decoded clip.
 *
 * MP3 encoders put a few hundred samples of their own padding at the head of a
 * file, and starting a buffer source lands wherever the audio thread happens to
 * be in its current render quantum. Between them the first few milliseconds of a
 * clip can get eaten — which on a percussive sound means losing the attack, the
 * one part of it you actually hear. Prepending real silence means whatever gets
 * clipped is silence rather than the transient.
 */
const PAD_SECONDS = 0.04;
/** scheduling headroom, so playback never begins mid-quantum */
const LOOKAHEAD = 0.015;
/** how far ahead of the moment you want to hear it that playSample must be called */
export const SAMPLE_LATENCY = PAD_SECONDS + LOOKAHEAD;

/** copy a decoded clip into a longer buffer that opens with silence */
function padFront(c: AudioContext, buffer: AudioBuffer, seconds: number): AudioBuffer {
  const pad = Math.round(seconds * buffer.sampleRate);
  if (pad <= 0) return buffer;
  // a fresh AudioBuffer is zero-filled, so the head is silent for free
  const out = c.createBuffer(buffer.numberOfChannels, buffer.length + pad, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.getChannelData(ch).set(buffer.getChannelData(ch), pad);
  }
  return out;
}

export function preloadSample(url: string): void {
  if (samples.has(url) || loading.has(url)) return;
  loading.add(url);
  fetch(url)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} for ${url}`))))
    .then((data) => ac().decodeAudioData(data))
    .then((decoded) => {
      samples.set(url, padFront(ac(), decoded, PAD_SECONDS));
    })
    .catch(() => {
      // a missing or unplayable effect must never take the round down with it
    })
    .finally(() => {
      loading.delete(url);
    });
}

export function playSample(url: string, gain = 1): void {
  if (muted) return;
  const buffer = samples.get(url);
  if (!buffer) {
    // not decoded yet — start it now so the next one lands
    preloadSample(url);
    return;
  }
  const c = ac();
  const src = c.createBufferSource();
  src.buffer = buffer;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(g).connect(c.destination);
  // scheduled, not "as soon as possible" — the latter can begin part-way through
  // a render quantum and clip the opening
  src.start(c.currentTime + LOOKAHEAD);
}
