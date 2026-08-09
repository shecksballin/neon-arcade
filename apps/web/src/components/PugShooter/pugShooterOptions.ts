/**
 * Player-tunable game options for Neon Pug Shooter.
 *
 * The lobby's Options panel and the in-game one (pause → Options) edit the same
 * localStorage entry — the iframe is same-origin — so a change made in either
 * place carries into the next boot. The game reads this key in
 * `neon pug shooter/src/main.js`; keep the key, fields and ranges mirrored there.
 */
export const PUG_SHOOTER_OPTIONS_KEY = 'pug_shooter_options';

export interface PugShooterOptions {
  sensitivity: number;
  fov: number;
  stretch: number;
  volume: number;
}

export const DEFAULT_OPTIONS: PugShooterOptions = {
  sensitivity: 1.0,
  fov: 103, // wide by default — it's a stretched-FOV third person game
  stretch: 1.25,
  volume: 0.7,
};

/** Mirrors the in-game sliders (index.html #options). */
export const OPTION_RANGES: Record<keyof PugShooterOptions, { min: number; max: number; step: number }> = {
  sensitivity: { min: 0.2, max: 3, step: 0.05 },
  fov: { min: 80, max: 120, step: 1 },
  stretch: { min: 1, max: 1.7, step: 0.01 },
  volume: { min: 0, max: 1, step: 0.05 },
};

const clamp = (value: unknown, key: keyof PugShooterOptions): number => {
  const { min, max } = OPTION_RANGES[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : DEFAULT_OPTIONS[key];
};

export function loadPugShooterOptions(): PugShooterOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(PUG_SHOOTER_OPTIONS_KEY) ?? '{}');
    return {
      sensitivity: clamp(saved.sensitivity, 'sensitivity'),
      fov: clamp(saved.fov, 'fov'),
      stretch: clamp(saved.stretch, 'stretch'),
      volume: clamp(saved.volume, 'volume'),
    };
  } catch {
    return { ...DEFAULT_OPTIONS }; // corrupt entry — fall back to defaults
  }
}

export function savePugShooterOptions(options: PugShooterOptions): void {
  try {
    localStorage.setItem(PUG_SHOOTER_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    /* storage blocked/full — options just won't stick */
  }
}
