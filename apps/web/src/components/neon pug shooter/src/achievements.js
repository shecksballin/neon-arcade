// Mini achievements — small awards for the shape of a kill rather than the fact of it.
//
// Every kill in the match is fed through record(), because two of these read the match
// rather than the shot: Rampage watches the kill feed as a sequence, and Avenge needs to
// know when a team-mate went down and to whom. Only the player's own kills are scored.
//
// Multipliers stack. A revenge kill taken at 12 health in the middle of a rampage pays
// 100 x 1.3 x 1.4 x 1.5 — deliberately, because all three conditions being true at once is
// a story worth paying for. Pro is the odd one out: a flat bonus, awarded once, for a
// standing you hold rather than a thing you just did.

export const KILL_POINTS = 100;
export const RAMPAGE_LENGTH = 3;      // consecutive kills in the feed, all yours
export const AVENGE_WINDOW = 10;      // seconds after a team-mate's death
export const LOW_HEALTH = 20;         // the "nearly dead" line, both ways
export const FULL_HEALTH = 100;       // untouched — what a One Tap has to start from
export const PRO_RATIO = 2.0;
// Headshots pay more but earn no badge: the HEADSHOT banner already announces them, and a
// second popup saying the same thing would just be noise.
export const HEADSHOT_MULTIPLIER = 1.5;

export const ACHIEVEMENTS = {
  revenge:  { label: 'Revenge',  multiplier: 1.3, blurb: 'killed the one who killed you' },
  survivor: { label: 'Survivor', multiplier: 1.4, blurb: `killed on ${LOW_HEALTH} health or less` },
  rampage:  { label: 'Rampage',  multiplier: 1.5, blurb: `${RAMPAGE_LENGTH} kills in a row` },
  avenge:   { label: 'Avenge',   multiplier: 1.2, blurb: 'avenged a team-mate' },
  saviour:  { label: 'Saviour',  multiplier: 1.3, blurb: 'saved a team-mate' },
  onetap:   { label: 'One Tap',  multiplier: 2.0, blurb: 'a full-health kill in a single shot' },
  pro:      { label: 'Pro',      bonus: 200,      blurb: `${PRO_RATIO.toFixed(1)} K/D` },
};

// The order awards are announced in, worst-to-best, so the rarest badge lands last.
const ORDER = ['survivor', 'avenge', 'saviour', 'revenge', 'rampage', 'onetap', 'pro'];

export function createAchievements({ playerEntity, entities }) {
  let feed = [];              // the tail of the kill feed, as killers
  let teamDeaths = [];        // { killer, at } for team-mates, pruned to the avenge window
  let killsSinceRespawn = 0;
  let proAwarded = false;

  const teammates = () => entities.filter((e) => e !== playerEntity && e.team === playerEntity.team);

  function ratio() {
    return playerEntity.deaths > 0 ? playerEntity.kills / playerEntity.deaths : playerEntity.kills;
  }

  /**
   * Log a kill. Returns what the player earned by it, or null for anyone else's kill.
   * `at` is match time in seconds.
   */
  function record({ killer, victim, at, headshot = false, oneTap = false }) {
    feed.push(killer);
    if (feed.length > RAMPAGE_LENGTH) feed.shift();

    if (victim !== playerEntity && victim.team === playerEntity.team) {
      teamDeaths.push({ killer, at });
    }
    teamDeaths = teamDeaths.filter((d) => at - d.at <= AVENGE_WINDOW);

    if (killer !== playerEntity) return null;
    return score({ victim, at, headshot, oneTap });
  }

  function score({ victim, at, headshot, oneTap }) {
    killsSinceRespawn++;
    const earned = [];

    // Revenge — your first kill back is on whoever put you down
    if (killsSinceRespawn === 1 && playerEntity.lastKilledBy === victim) earned.push('revenge');

    // Survivor — you were nearly gone yourself when you took it
    if (playerEntity.health <= LOW_HEALTH) earned.push('survivor');

    // Rampage — the last three names in the feed are all you
    if (feed.length === RAMPAGE_LENGTH && feed.every((k) => k === playerEntity)) earned.push('rampage');

    // Avenge — they put a team-mate down moments ago
    if (teamDeaths.some((d) => d.killer === victim && at - d.at <= AVENGE_WINDOW)) earned.push('avenge');

    // Saviour — they had a team-mate on the ropes and you took them off it
    if (teammates().some((t) => t.alive && t.health <= LOW_HEALTH && t.lowHealthBy === victim)) {
      earned.push('saviour');
    }

    // One Tap — they were untouched and one shot finished it. With a 22-damage body shot
    // that only a headshot can do, which is the point: it is the hardest kill in the game.
    if (oneTap) earned.push('onetap');

    // Pro — a standing, not an event, so it pays out once when you first reach it
    if (!proAwarded && ratio() >= PRO_RATIO) { proAwarded = true; earned.push('pro'); }

    let points = KILL_POINTS;
    if (headshot) points *= HEADSHOT_MULTIPLIER;
    let bonus = 0;
    for (const id of earned) {
      const a = ACHIEVEMENTS[id];
      if (a.multiplier) points *= a.multiplier;
      if (a.bonus) bonus += a.bonus;
    }

    earned.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    return { earned, points: Math.round(points) + bonus };
  }

  return {
    record,
    // a fresh life is what makes the next kill a candidate for Revenge
    onRespawn() { killsSinceRespawn = 0; },
    reset() { feed = []; teamDeaths = []; killsSinceRespawn = 0; proAwarded = false; },
  };
}
