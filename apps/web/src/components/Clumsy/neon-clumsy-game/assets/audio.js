// WebAudio: the music loop only — one-shot SFX were removed by request
// (the class shape survives so the mute button and boot flow are unchanged).
import { CFG } from "./config.js";

const FILES = {
  music: "./assets/audio/music.m4a",
};

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.muted = false;
    this.musicNodes = null;
    this.master = null;
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

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 1;
    return this.muted;
  }
}
