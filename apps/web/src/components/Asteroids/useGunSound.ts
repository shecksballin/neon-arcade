import { useRef, useCallback } from 'react';
import { Howl } from 'howler';

// Initialize Howler instance outside hook to load the resource only once
const fireSound = new Howl({
  src: ['/Hit7 (3).wav'],
  volume: 0.3,
  preload: true,
});

const reloadSound = new Howl({
  src: ['/reloadsoundfx.wav'],
  volume: 0.5,
  preload: true,
});

export function useGunSound() {
  const shotCountRef = useRef(0);       // shots in current burst
  const burstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const burstStartRef = useRef<number>(0);

  const playShot = useCallback(() => {
    try {
      const id = fireSound.play();
      // Add a subtle random speed/pitch variation (0.9 to 1.1) to avoid ear fatigue during rapid firing
      fireSound.rate(0.9 + Math.random() * 0.2, id);
    } catch (err) {
      console.warn("Failed to play fire sound with Howler:", err);
    }
  }, []);

  const triggerReload = useCallback(() => {
    try {
      reloadSound.play();
    } catch (err) {
      console.warn("Failed to play reload sound with Howler:", err);
    }
  }, []);

  // Call this every time a shot fires
  const triggerShot = useCallback(() => {
    const now = Date.now();

    // Reset burst counter if gap > 180ms
    if (burstTimerRef.current) clearTimeout(burstTimerRef.current);
    if (now - burstStartRef.current > 180) {
      shotCountRef.current = 0;
      burstStartRef.current = now;
    }

    playShot();
    shotCountRef.current++;

    // Reset after silence
    burstTimerRef.current = setTimeout(() => {
      shotCountRef.current = 0;
    }, 180);
  }, [playShot]);

  return { triggerShot, triggerReload };
}

