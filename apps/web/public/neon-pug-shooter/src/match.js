import { createBot } from './bots.js';

export const MODES = {
  ffa: {
    label: 'Free For All',
    bots: 5,
    teams: false,
    target: 15,
    time: 360,
    skill: [0.45, 0.55, 0.6, 0.68, 0.75],
    describe: 'first to 15 kills',
  },
  duel: {
    label: '1v1 Duel',
    bots: 1,
    teams: true,
    target: 10,
    time: 300,
    skill: [0.82],
    describe: 'first to 10 kills',
  },
  duo: {
    label: '2v2 Teams',
    bots: 3,          // 1 ally + 2 enemies
    teams: true,
    target: 20,
    time: 420,
    skill: [0.62, 0.66, 0.7],
    describe: 'first team to 20 kills',
  },
};

// No colour multiply: shaded.png stays exactly as authored. Team identity is carried by a
// low emissive instead, which reads on the near-black jacket without staining the artwork.
const NO_TINT = '#ffffff';
const ALLY_GLOW = '#2f6fc4';
const ENEMY_GLOW = '#c43a22';
const FFA_GLOWS = ['#c43a22', '#c08a1c', '#4f9c33', '#8a49c0', '#1f9c94'];

export function createMatch({ mode, difficulty, scene, collision, combat, player, ui, onFinish, onKillLogged }) {
  const config = MODES[mode];
  const entities = [player.entity];
  const bots = [];

  player.entity.team = 0;
  player.entity.kills = 0;
  player.entity.deaths = 0;
  player.entity.score = 0;
  player.entity.lastKilledBy = null;
  player.entity.lowHealthBy = null;
  // the player entity outlives the match, so this has to be cleared or a locked-down
  // finish would follow them into the next one
  player.entity.invulnerable = false;

  for (let i = 0; i < config.bots; i++) {
    let team, teamGlow;
    const tint = NO_TINT;
    if (mode === 'ffa') {
      team = i + 1;                       // everyone is their own team
      teamGlow = FFA_GLOWS[i % FFA_GLOWS.length];
    } else if (mode === 'duo') {
      const ally = i === 0;
      team = ally ? 0 : 1;
      teamGlow = ally ? ALLY_GLOW : ENEMY_GLOW;
    } else {
      team = 1;
      teamGlow = ENEMY_GLOW;
    }

    const bot = createBot({
      scene, collision, combat, team, tint, teamGlow, difficulty,
      skill: config.skill[i] ?? 0.6,
    });
    // the scoreboard reuses the in-world team colour, so a row reads as the pug you see
    bot.glow = teamGlow;
    bot.onKill = (victim, headshot) => {
      ui.addKill(bot, victim, headshot, player.entity.team);
      onKillLogged?.(bot, victim, headshot);
      checkEnd();
    };
    bots.push(bot);
    entities.push(bot);
  }

  // ---- spawning
  // collision.findOpenPoint() guarantees the spot itself is clear of map geometry; this
  // only has to keep bodies off each other and opponents at arm's length.
  const CLEAR_OF_ENEMIES = 30;
  const CLEAR_OF_ANYONE = 4;      // including team-mates — nobody spawns inside a pug

  function occupied(p, forEntity) {
    return entities.some((e) =>
      e !== forEntity && e.alive && p.distanceTo(e.position) < CLEAR_OF_ANYONE);
  }

  function spawnPoint(forEntity) {
    let best = null;
    let bestDist = -1;
    for (let i = 0; i < 24; i++) {
      const p = collision.findOpenPoint();
      if (occupied(p, forEntity)) continue;
      let nearest = Infinity;
      for (const e of entities) {
        if (e === forEntity || !e.alive) continue;
        if (config.teams && e.team === forEntity.team) continue;
        nearest = Math.min(nearest, p.distanceTo(e.position));
      }
      if (nearest > CLEAR_OF_ENEMIES) return p;
      if (nearest > bestDist) { bestDist = nearest; best = p; }
    }
    return best ?? collision.findOpenPoint();
  }

  function start() {
    player.spawn(spawnPoint(player.entity));
    for (const bot of bots) bot.spawn(spawnPoint(bot));
  }

  function respawn(entity) {
    if (entity.isPlayer) player.spawn(spawnPoint(entity));
    else entity.spawn(spawnPoint(entity));
  }

  // ---- scoring
  let timeLeft = config.time;
  let over = false;
  let result = null;

  function teamScore(team) {
    return entities.filter((e) => e.team === team).reduce((sum, e) => sum + e.kills, 0);
  }

  function leaderScore() {
    if (config.teams) return Math.max(teamScore(0), teamScore(1));
    return Math.max(...entities.map((e) => e.kills));
  }

  function checkEnd() {
    if (over) return;
    if (leaderScore() >= config.target) finish();
  }

  function finish() {
    over = true;
    // The match is decided, but the world runs on for a couple of seconds so the final cam
    // can film the aftermath. Nobody may die in that window: a late kill would overwrite
    // the winning one and the "final kill" would end up replaying somebody else's shot.
    // In free-for-all, with everyone still fighting, that was most of the time.
    for (const e of entities) e.invulnerable = true;
    if (config.teams) {
      const mine = teamScore(0);
      const theirs = teamScore(1);
      result = {
        won: mine > theirs,
        title: mine > theirs ? 'Victory' : mine === theirs ? 'Draw' : 'Defeat',
        detail: `${mine} — ${theirs}`,
      };
    } else {
      const sorted = [...entities].sort((a, b) => b.kills - a.kills);
      const winner = sorted[0];
      result = {
        won: winner.isPlayer,
        title: winner.isPlayer ? 'Victory' : `${winner.name} wins`,
        detail: `you finished ${sorted.indexOf(player.entity) + 1}/${entities.length} with ${player.entity.kills} kills`,
      };
    }
    // main runs the final killcam first, then puts the results up
    onFinish?.(result);
  }

  function scoreText() {
    if (config.teams) {
      return `<span class="team-a">${teamScore(0)}</span><span class="sep">:</span>` +
             `<span class="team-b">${teamScore(1)}</span>` +
             `<span class="target">to ${config.target}</span>`;
    }
    const sorted = [...entities].sort((a, b) => b.kills - a.kills);
    const lead = sorted[0];
    return `<span class="team-a">${player.entity.kills}</span>` +
           `<span class="target">lead ${lead.isPlayer ? 'you' : lead.name} ${lead.kills}/${config.target}</span>`;
  }

  const byScore = (a, b) => b.kills - a.kills || a.deaths - b.deaths;

  function row(e) {
    return {
      name: e.isPlayer ? 'you' : e.name,
      kills: e.kills,
      deaths: e.deaths,
      score: e.score ?? 0,
      team: e.team,
      color: e.isPlayer ? '#00FFD1' : (e.glow ?? ENEMY_GLOW),
      isPlayer: !!e.isPlayer,
    };
  }

  function scoreboardRows() {
    return [...entities].sort(byScore).map(row);
  }

  // The full scoreboard card. Free-for-all is one unbroken list; team modes split into a
  // block per side, which is the only separation the card draws.
  function scoreboardModel() {
    if (!config.teams) {
      return {
        title: config.label,
        subtitle: config.describe,
        groups: [{ rows: scoreboardRows() }],
      };
    }
    const side = (team, label, enemy) => ({
      label,
      enemy,
      score: teamScore(team),
      rows: entities.filter((e) => e.team === team).sort(byScore).map(row),
    });
    const solo = mode === 'duel';
    return {
      title: config.label,
      subtitle: config.describe,
      groups: [
        side(0, solo ? 'you' : 'your team', false),
        side(1, solo ? 'opponent' : 'enemy team', true),
      ],
    };
  }

  // `keepAlive` runs the world on past the final whistle without touching the clock or the
  // score — main.js uses it to film the couple of seconds after the match-winning kill.
  function update(dt, keepAlive = false) {
    if (over && !keepAlive) return;
    if (!over) {
      timeLeft -= dt;
      if (timeLeft <= 0) finish();
    }

    for (const bot of bots) {
      bot.update(dt, entities);
      if (!bot.alive && bot.respawnTimer <= 0) respawn(bot);
    }
  }

  return {
    mode,
    difficulty,
    config,
    entities,
    bots,
    start,
    update,
    respawn,
    checkEnd,
    scoreText,
    scoreboardRows,
    scoreboardModel,
    get timeLeft() { return timeLeft; },
    get over() { return over; },
    get result() { return result; },
  };
}
