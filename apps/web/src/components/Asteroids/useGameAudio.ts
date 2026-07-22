import { useRef, useCallback } from 'react';
import { Howl } from 'howler';

const deathSound = new Howl({
  src: ['/hitHurt.wav'],
  volume: 0.8,
  preload: true,
});

export function useGameAudio() {
  const ctxRef = useRef<AudioContext | null>(null);

  const getCtx = () => {
    if (!ctxRef.current) {
      ctxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (ctxRef.current.state === 'suspended') {
      ctxRef.current.resume();
    }
    return ctxRef.current;
  };

  const playHitmarker = useCallback(() => {
    if (localStorage.getItem('gameMuted') === 'true') return;
    const ctx = getCtx();
    const now = ctx.currentTime;

    // The classic hitmarker is a very short high-passed white noise burst
    const bufLen = ctx.sampleRate * 0.03;
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.005));
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1500;
    filter.Q.value = 1;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.03);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    source.start(now);
    source.stop(now + 0.04);
  }, []);

  const playKillSound = useCallback(() => {
    if (localStorage.getItem('gameMuted') === 'true') return;
    const ctx = getCtx();
    const now = ctx.currentTime;

    // Louder celebratory "Ding"
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.2);

    oscGain.gain.setValueAtTime(0.8, now); // Increased from 0.3
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(100, now);
    sub.frequency.exponentialRampToValueAtTime(40, now + 0.15);

    subGain.gain.setValueAtTime(1.0, now); // Increased from 0.6
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-10, now);

    osc.connect(oscGain);
    oscGain.connect(compressor);
    sub.connect(subGain);
    subGain.connect(compressor);
    compressor.connect(ctx.destination);

    osc.start(now);
    sub.start(now);
    osc.stop(now + 0.4);
    sub.stop(now + 0.3);
  }, []);

  const playCritHit = useCallback(() => {
    if (localStorage.getItem('gameMuted') === 'true') return;
    const ctx = getCtx();
    const now = ctx.currentTime;

    // A metallic "clink" for critical backstabs
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.exponentialRampToValueAtTime(1800, now + 0.05);

    oscGain.gain.setValueAtTime(0.15, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.connect(oscGain);
    oscGain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.1);
  }, []);

  const playKillstreakSound = useCallback(() => {
    if (localStorage.getItem('gameMuted') === 'true') return;
    const ctx = getCtx();
    const now = ctx.currentTime;
    
    // Create a powerful multi-layered killstreak sound
    // Layer 1: A deep bass impact
    const bass = ctx.createOscillator();
    const bassGain = ctx.createGain();
    bass.type = 'triangle';
    bass.frequency.setValueAtTime(80, now);
    bass.frequency.exponentialRampToValueAtTime(40, now + 0.5);
    
    bassGain.gain.setValueAtTime(0.6, now);
    bassGain.gain.exponentialRampToValueAtTime(0.01, now + 1.0);
    
    bass.connect(bassGain);
    bassGain.connect(ctx.destination);
    
    // Layer 2: A rising "announcer" style synth
    const lead = ctx.createOscillator();
    const leadGain = ctx.createGain();
    lead.type = 'sawtooth';
    lead.frequency.setValueAtTime(150, now);
    lead.frequency.exponentialRampToValueAtTime(600, now + 0.3);
    
    leadGain.gain.setValueAtTime(0, now);
    leadGain.gain.linearRampToValueAtTime(0.2, now + 0.05);
    leadGain.gain.exponentialRampToValueAtTime(0.01, now + 0.8);
    
    lead.connect(leadGain);
    leadGain.connect(ctx.destination);
    
    bass.start(now);
    bass.stop(now + 1.0);
    lead.start(now);
    lead.stop(now + 0.8);
  }, []);

  const playDeath = useCallback(() => {
    try {
      if (localStorage.getItem('gameMuted') !== 'true') {
        deathSound.play();
      }
    } catch (err) {
      console.warn("Failed to play death sound with Howler:", err);
    }
  }, []);

  return { playHitmarker, playKillSound, playCritHit, playKillstreakSound, playDeath };
}
