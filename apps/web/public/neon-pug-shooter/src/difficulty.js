// Bot difficulty.
//
// The lever that decides a fight here is the head. A headshot is an instant kill at any
// range, so how freely a bot may take one matters more than how well it shoots. Hard is
// the bots exactly as they were built: every shot may find a head, purely by where the
// spread happens to land. Normal and Easy put that on a leash — a ray that strays through
// the head sphere is demoted to a body hit, and a real headshot has to be *earned* by
// landing a set number of body shots first. So the cadence is a promise, not an average:
// on Normal you will take a headshot on the tenth body shot, not somewhere near it.
//
// `extraMiss` throws a share of shots deliberately wide. Note what it is not: the bots
// already miss about three quarters of what they fire, so "half again as many misses"
// isn't available — that would be more than every shot. It is expressed the way it is
// actually felt instead, as how often you get hit: at 0.5, Easy lands half as many shots
// as the other two.

export const DIFFICULTIES = {
  easy: {
    label: 'Easy',
    describe: 'lands half as many shots · a headshot every 100 body shots',
    headshotEvery: 100,
    extraMiss: 0.5,
  },
  normal: {
    label: 'Normal',
    describe: 'shoots like Hard · a headshot every 10 body shots',
    headshotEvery: 10,
    extraMiss: 0,
  },
  hard: {
    label: 'Hard',
    describe: 'off the leash · any shot can take your head off',
    headshotEvery: 0,      // 0 — no budget, headshots whenever the spread lands one
    extraMiss: 0,
  },
};

export const DEFAULT_DIFFICULTY = 'normal';
