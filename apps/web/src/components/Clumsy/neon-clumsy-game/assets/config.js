// Every balance number for Neon Clumsy lives here (tuned as data, one change
// at a time). Units: meters, seconds, radians.
export const CFG = {
  // --- world / level ---
  layers: 6,
  layerGap: 5.5,          // vertical distance between hex layers
  hexRings: 6,            // rings per layer -> 127 tiles
  hexRadius: 1.15,        // circumradius of one tile
  tileHeight: 0.42,
  slimeY: -3.6,           // slime surface height (layer 0 tops sit at y=0)
  killY: -3.25,           // character center below this = eliminated
  layerColors: [0xff3ea5, 0x0fa3a8, 0xffd84d, 0x8a5cff, 0xff6b81, 0x00ffd1], // bottom->top
  rimColor: 0x00ffd1,
  // Neon-arcade night: the violet/pink dusk the game shipped with was the
  // one sky in the arcade that didn't match the #081616/mint identity. Deep
  // teal-black overhead falling to a mint-glow horizon, teal fog to match.
  fogColor: 0x0a2824,
  skyTop: 0x061a17,
  skyBottom: 0x00bfa0,

  // --- tiles ---
  tileWobbleTime: 0.5,    // touched -> crumble delay
  tileCrumbleTime: 0.28,  // shrink/drop duration
  tileRespawn: false,

  // --- movement ---
  // walk crosses a 2m tile in ~0.42s, inside the 0.5s wobble window,
  // so steady walking outruns the crumble
  walkSpeed: 4.8,
  sprintSpeed: 7.4,
  accel: 30.0,
  airControl: 0.35,
  gravity: -22.0,
  jumpVel: 8.4,
  diveUpVel: 3.2,
  diveSpeed: 8.6,
  charRadius: 0.38,       // capsule radius for char-vs-char
  charHeight: 1.5,        // visual target height (model auto-scaled)
  snapDist: 0.22,         // ground snap tolerance
  turnLerp: 12.0,         // facing turn rate
  yawTurnAnimThreshold: 1.1, // rad/s of camera yaw that triggers sprint-turn anims

  // --- bumps / trips ---
  bumpTripSpeed: 5.2,     // attacker speed needed to trip someone
  bumpImpulse: 6.0,
  bumpUpImpulse: 3.0,
  tripImmunity: 1.8,      // seconds of post-trip immunity
  tripLockTime: 1.05,     // control lock while tripped (anim plays)
  getUpLockTime: 0.85,
  ragdollImpulseThreshold: 8.5, // bump impulse beyond this = full ragdoll
  ragdollRecoverTime: 1.7,

  // --- ragdoll (Rapier) ---
  ragGravity: -18.0,
  ragLinearDamping: 0.35,
  ragAngularDamping: 0.6,
  ragMaxConcurrent: 4,

  // --- camera ---
  camDist: 4.2,
  camHeight: 1.55,
  camPitchMin: -0.9,
  camPitchMax: 0.55,
  camLerp: 14.0,
  mouseSens: 0.0023,
  padLookSpeed: 2.6,

  // --- round ---
  players: 12,            // 1 human + 11 bots
  countdownTime: 3.4,
  spawnRingRadius: 4.6,

  // --- bots (three skill tiers) ---
  botTiers: [
    { n: 2, replan: 0.35, speed: 1.0,  mistake: 0.02, bump: 0.45, dive: 0.5 },
    { n: 6, replan: 0.55, speed: 0.95, mistake: 0.06, bump: 0.25, dive: 0.3 },
    { n: 3, replan: 0.85, speed: 0.9,  mistake: 0.13, bump: 0.15, dive: 0.15 },
  ],

  // --- audio mix (music quiet under SFX, per the audio reference) ---
  musicGain: 0.14,
  sfxGain: { crumble: 0.32, jump: 0.4, dive: 0.38, splat: 0.55, crowd: 0.5 },

  // --- rendering / perf budget: 60fps on a mid laptop ---
  dprCap: 1.75,
  dprCapMobile: 1.0,
  shadows: true,
  shadowMapSize: 1024,
  maxNameTagDist: 26,
};
