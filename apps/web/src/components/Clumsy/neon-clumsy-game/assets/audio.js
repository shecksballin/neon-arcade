// WebAudio: generated music loop + one-shot SFX, mixed per the audio
// reference (music sits far below SFX).
import { CFG } from "./config.js";

const FILES = {
  music: "./assets/audio/music.m4a",
  crumble: "./assets/audio/crumble.mp3",
  jump: "./assets/audio/jump.mp3",
  dive: "./assets/audio/dive.mp3",
  splat: "./assets/audio/splat.mp3",
  crowd: "./assets/audio/crowd.mp3",
};

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.muted = false;
    this.musicNodes = null;
    this.master = null;
    this._lastPlay = new Map();
  }

  async load() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
    await Promise.all(Object.entries(FILES).map(async ([name, url]) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
        this.buffers.set(name, buf);
      } catch (err) {
        console.warn("audio missing:", name, err.message || err);
      }
    }));
  }

  resume() { if (this.ctx && this.ctx.state === "suspended") this.ctx.resume(); }

  playMusic() {
    if (this.musicNodes || !this.buffers.has("music")) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.get("music");
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = CFG.musicGain;
    src.connect(g); g.connect(this.master);
    src.start();
    this.musicNodes = { src, g };
  }

  sfx(name, { vol = null, rate = 1, throttle = 0.09 } = {}) {
    if (!this.buffers.has(name) || !this.ctx) return;
    const now = this.ctx.currentTime;
    const last = this._lastPlay.get(name) || -9;
    if (now - last < throttle) return;
    this._lastPlay.set(name, now);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.get(name);
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = vol !== null ? vol : (CFG.sfxGain[name] || 0.4);
    src.connect(g); g.connect(this.master);
    src.start();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 1;
    return this.muted;
  }
}
