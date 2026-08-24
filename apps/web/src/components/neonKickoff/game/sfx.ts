import { Howl, Howler } from 'howler';

/**
 * Recorded sound effects, played through howler.
 *
 * howler is worth the dependency for one-shots that fire mid-round: it decodes
 * each file once up front, pools voices so a sound retriggering before the last
 * one has finished does not cut it off, and handles the browser's autoplay
 * unlock without us tracking gestures ourselves.
 *
 * The synthesised effects in audio.ts (whistle, crowd) stay where they are —
 * there is no file to load for those, so there is nothing for howler to manage.
 */

const SOURCES = {
  /** boot on ball */
  kick: { src: '/neon-kickoff/kick-sound-fx.wav', volume: 0.85 },
  /** the keeper getting a glove to it */
  save: { src: '/neon-kickoff/save-sound-fx.wav', volume: 0.9 },
} as const;

export type SfxName = keyof typeof SOURCES;

const clips = new Map<SfxName, Howl>();

/**
 * howler needs a browser to build a Howl at all. Guarding here keeps the module
 * importable from tools/simulate.ts, which plays whole shootouts through the
 * real store under node with no DOM at all.
 */
const HAS_AUDIO = typeof window !== 'undefined';

/**
 * Build every clip up front.
 *
 * Called from the menu's start button, so decoding happens on a user gesture
 * while there is a loading screen to hide behind, rather than at the moment a
 * boot connects.
 */
export function loadSfx(): void {
  if (!HAS_AUDIO) return;
  for (const name of Object.keys(SOURCES) as SfxName[]) {
    if (clips.has(name)) continue;
    const { src, volume } = SOURCES[name];
    clips.set(
      name,
      new Howl({
        src: [src],
        volume,
        preload: true,
        // a failed effect must never take the round down with it
        onloaderror: () => {},
        onplayerror: () => {},
      })
    );
  }
}

export function playSfx(name: SfxName): void {
  if (!HAS_AUDIO) return;
  const clip = clips.get(name);
  if (!clip) {
    // first call before the match started — build it and let the next one land
    loadSfx();
    return;
  }
  clip.play();
}

/** the HUD's volume button drives howler's master mute alongside the synth flag */
export function setSfxMuted(muted: boolean): void {
  if (!HAS_AUDIO) return;
  Howler.mute(muted);
}
