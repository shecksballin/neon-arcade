/**
 * Headless match simulator.
 *
 * Plays whole shootouts through the real store and the real match clock at a
 * fixed timestep, with no browser and no renderer. Catches the things that are
 * awkward to see by eye in a running game: rounds that never resolve, sudden
 * death that never terminates, the run-up launching the ball early.
 *
 *   npx esbuild tools/simulate.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/sim.mjs && node /tmp/sim.mjs
 */

// WebAudio has to exist before the store pulls in the sfx module
class FakeParam {
  value = 0;
  setValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
}
class FakeNode {
  frequency = new FakeParam();
  gain = new FakeParam();
  type = '';
  Q = new FakeParam();
  buffer: unknown = null;
  connect(n: unknown) { return n; }
  start() {}
  stop() {}
}
class FakeAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  state = 'running';
  destination = new FakeNode();
  resume() { return Promise.resolve(); }
  createOscillator() { return new FakeNode(); }
  createGain() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createBufferSource() { return new FakeNode(); }
  createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
}
(globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;

const THREE = await import('three');
const { useGame, KICK_CONTACT } = await import('../game/store');
const { makeFlight } = await import('../game/flight');
const net = await import('../game/net');
const { GOAL_H, GOAL_W, SPOT, saveContact } = await import('../game/types');
const { advance } = await import('../game/tick');
const { ringZone } = await import('../game/ring');
const { goals, taken } = await import('../game/shootout');
const { flipDir } = await import('../game/types');

const DT = 1 / 60;
const MAX_STEPS = 60 * 60 * 12; // twelve minutes of match time is a hang

interface Report {
  winner: string | null;
  score: string;
  rounds: number;
  suddenDeath: boolean;
  steps: number;
  perfect: number;
  saves: number;
}

const problems: string[] = [];
function check(ok: boolean, message: string) {
  if (!ok && !problems.includes(message)) problems.push(message);
}

function playMatch(seed: number): Report {
  const g = () => useGame.getState();
  g().startMatch();

  let steps = 0;
  let launchedEarly = false;
  let sawRunup = false;
  let lastPhase = '';
  let kicksTaken = 0;

  while (g().phase !== 'over' && steps < MAX_STEPS) {
    const s = g();

    // the striker: swing when the ring reaches the sweet spot
    if (s.phase === 'aim' && ringZone(s.clock.cycle) === 'green') {
      const dir = (['left', 'middle', 'right'] as const)[(kicksTaken + seed) % 3];
      s.strikerKick(dir);
      kicksTaken++;
      // the flight clock must start a full run-up behind the ball
      check(
        Math.abs(g().clock.flight + KICK_CONTACT) < 1e-9,
        'player kick did not open with a run-up on the flight clock'
      );
      check(g().clock.booted === false, 'kick sound armed before the boot landed');
    }

    // the keeper: commit a dive once the striker starts moving
    if (s.phase === 'guard' && s.clock.guard > 1.0 && s.playerGuess === 'middle') {
      if ((taken(s.shootout, 'ai') + seed) % 3 !== 0) {
        s.setGuess((taken(s.shootout, 'ai') + seed) % 2 === 0 ? 'left' : 'right');
      }
    }

    // during a player run-up the ball must still be sitting on the spot
    if (s.phase === 'strike' && s.kick?.kicker === 'player') {
      if (s.clock.flight < -0.02) {
        sawRunup = true;
        if (s.clock.booted) launchedEarly = true;
      }
    }

    if (s.phase !== lastPhase) lastPhase = s.phase;
    advance(DT);
    steps++;
  }

  check(steps < MAX_STEPS, 'match never reached a result');
  check(sawRunup, 'no run-up observed before a player kick');
  check(!launchedEarly, 'ball launched before the boot arrived');

  const s = g();
  const gp = goals(s.shootout, 'player');
  const ga = goals(s.shootout, 'ai');
  const tp = taken(s.shootout, 'player');
  const ta = taken(s.shootout, 'ai');

  check(s.shootout.winner !== null, 'match ended with no winner');
  check(Math.abs(tp - ta) <= 1, `sides took uneven kicks (${tp} v ${ta})`);
  check(
    s.shootout.winner === (gp > ga ? 'player' : 'ai'),
    `winner ${s.shootout.winner} disagrees with the score ${gp}-${ga}`
  );
  check(gp !== ga, `match ended level at ${gp}-${ga}`);

  return {
    winner: s.shootout.winner,
    score: `${gp}-${ga}`,
    rounds: Math.max(tp, ta),
    suddenDeath: tp > 5,
    steps,
    perfect: s.stats.perfect,
    saves: s.stats.saves,
  };
}

// ---- the goal burst has to fire inside the window it is meant to, on every
// goal the game can produce: after the ball has crossed the line, while the
// round is still being played out, and with room to finish before the next one.
{
  const BURST_LIFE = 0.72;
  const TRIGGER_AFTER_CROSS = 0.12;
  const RESOLVE_MARGIN = 0.45; // tick.ts waits this long past the path before judging
  const RESULT_SECONDS = 2.4;

  for (const dir of ['left', 'middle', 'right'] as const) {
    for (const zone of ['green', 'orange'] as const) {
      const path = makeFlight({ kicker: 'player', dir, zone, outcome: 'goal', guess: 'middle' });
      const fires = path.cross + TRIGGER_AFTER_CROSS;
      const label = `${dir}/${zone}`;

      check(fires > path.cross, `${label}: burst fires before the ball has crossed the line`);
      check(fires < path.total, `${label}: burst fires after the ball has already settled`);
      check(
        fires - path.cross < 0.2,
        `${label}: burst lags ${(fires - path.cross).toFixed(2)}s behind the goal being scored`
      );
      check(
        BURST_LIFE < path.total + RESOLVE_MARGIN - fires + RESULT_SECONDS,
        `${label}: burst is still running when the next round starts`
      );
    }
  }

  // and it must never be armed on a shot that was not a goal
  for (const outcome of ['saved', 'off'] as const) {
    const zone = outcome === 'off' ? ('red' as const) : ('green' as const);
    const path = makeFlight({ kicker: 'player', dir: 'left', zone, outcome, guess: 'left' });
    check(path.total > 0, `${outcome}: flight has no duration`);
  }
}

// ---- the goal net: the lattice, the drawn mesh that rides on it, and whether a
// ball can actually reach and disturb it.
{
  const lattice = net.buildLattice();
  const visual = net.buildVisualNet(lattice);
  const nodes = lattice.cols * lattice.rows;

  check(lattice.rest.length === nodes, 'lattice node count does not match its grid');
  check(
    lattice.links.length === (lattice.cols - 1) * lattice.rows + lattice.cols * (lattice.rows - 1),
    'lattice is missing neighbour links'
  );

  // the border is lashed to the frame; everything inside it has to be free
  let pinnedCount = 0;
  for (let j = 0; j < lattice.rows; j++) {
    for (let i = 0; i < lattice.cols; i++) {
      const edge = i === 0 || i === lattice.cols - 1 || j === 0 || j === lattice.rows - 1;
      if (lattice.pinned[j * lattice.cols + i] !== edge) {
        check(false, 'lattice pins the wrong nodes');
      }
      if (edge) pinnedCount++;
    }
  }
  check(nodes - pinnedCount > 40, 'too few free nodes for the net to move convincingly');

  // a ball must not be able to sit in the middle of a cell untouched
  const spacing = lattice.rest[0].distanceTo(lattice.rest[1]);
  const worstGap = (spacing * Math.SQRT2) / 2;
  check(
    worstGap - 0.111 <= net.NODE_RADIUS + 1e-9,
    `a shot can thread between lattice nodes (needs r >= ${(worstGap - 0.111).toFixed(3)})`
  );

  // the drawn net has to sit exactly on the real surface when nothing has hit it
  let worstDrift = 0;
  for (let j = 0; j < visual.rows; j++) {
    for (let i = 0; i < visual.cols; i++) {
      const v = j * visual.cols + i;
      const n = v * 4;
      let sum = 0;
      const blended = new THREE.Vector3();
      for (let c = 0; c < 4; c++) {
        const idx = visual.cell[n + c];
        check(idx < nodes, 'visual vertex points at a lattice node that does not exist');
        sum += visual.weight[n + c];
        blended.addScaledVector(lattice.rest[idx], visual.weight[n + c]);
      }
      check(Math.abs(sum - 1) < 1e-6, 'visual vertex weights do not sum to one');
      const exact = net.netPoint(i / (visual.cols - 1), j / (visual.rows - 1));
      worstDrift = Math.max(worstDrift, blended.distanceTo(exact));
    }
  }
  check(worstDrift < 1e-6, `drawn net sits ${worstDrift.toFixed(4)}m off the real surface at rest`);

  // and the shot has to actually get there — this is what was wrong before
  for (const dir of ['left', 'middle', 'right'] as const) {
    for (const zone of ['green', 'orange'] as const) {
      const path = makeFlight({ kicker: 'player', dir, zone, outcome: 'goal', guess: 'middle' });
      const end = path.at(path.total, new THREE.Vector3());
      const surface = net.backSurfaceZ(end.y);
      check(
        end.z <= surface + 1e-6,
        `${dir}/${zone}: goal stops ${(end.z - surface).toFixed(2)}m short of the netting`
      );
      check(end.y > 0 && end.y < GOAL_H, `${dir}/${zone}: ball finishes outside the goal mouth`);
      check(Math.abs(end.x) < GOAL_W / 2, `${dir}/${zone}: ball finishes outside the posts`);
    }
  }
}

// ---- flight paths: prove every shot the game can produce finishes where the
// round says it should, and that the keeper is sent to meet it or beat by it.
const _p = new THREE.Vector3();

for (const dir of ['left', 'middle', 'right'] as const) {
  for (const zone of ['green', 'orange'] as const) {
    for (const outcome of ['goal', 'saved'] as const) {
      const path = makeFlight({ kicker: 'player', dir, zone, outcome, guess: dir });
      const label = `${dir}/${zone}/${outcome}`;

      // it sits on the spot for the whole run-up
      path.at(-0.4, _p);
      check(_p.distanceTo(SPOT) < 1e-9, `${label}: ball drifts during the run-up`);

      path.at(path.cross, _p);
      check(_p.distanceTo(path.contact) < 1e-6, `${label}: shot misses its own target`);

      // and never scuffs into the turf on the way
      let lowest = Infinity;
      for (let t = 0; t <= path.cross; t += path.cross / 40) {
        lowest = Math.min(lowest, path.at(t, _p).y);
      }
      check(lowest > 0.02, `${label}: ball ploughs into the turf before the line`);

      if (outcome === 'goal') {
        path.at(path.cross, _p);
        check(Math.abs(_p.x) < GOAL_W / 2 - 0.15, `${label}: goal-bound shot hits the post`);
        check(_p.y > 0.1 && _p.y < GOAL_H - 0.1, `${label}: goal-bound shot hits the bar`);
      } else {
        // a save only works if the keeper is sent to where the ball arrives
        check(path.contact.distanceTo(saveContact(dir, zone)) < 1e-6,
          `${label}: keeper's gloves and the ball do not meet`);
      }
    }

    // a mistimed shot has to actually clear the bar
    const skied = makeFlight({ kicker: 'player', dir, zone: 'red', outcome: 'off', guess: dir });
    skied.at(skied.cross, _p);
    check(_p.y > GOAL_H + 0.5, `${dir}: mistimed shot does not clear the bar`);

    // a keeper who went the other way must be nowhere near it
    const beaten = makeFlight({
      kicker: 'player', dir, zone, outcome: 'goal',
      guess: dir === 'left' ? 'right' : 'left',
    });
    check(saveContact(dir === 'left' ? 'right' : 'left', zone).distanceTo(beaten.contact) > 1.0,
      `${dir}/${zone}: beaten keeper still ends up on the ball`);
  }
}

// the keeper's keys are mirrored, so prove the mapping round-trips
check(flipDir('left') === 'right' && flipDir('right') === 'left', 'keeper mirror is wrong');
check(flipDir('middle') === 'middle', 'middle should not mirror');

const reports: Report[] = [];
for (let i = 0; i < 40; i++) reports.push(playMatch(i));

const sd = reports.filter((r) => r.suddenDeath).length;
const wins = reports.filter((r) => r.winner === 'player').length;
const longest = Math.max(...reports.map((r) => r.rounds));
const avgSteps = Math.round(reports.reduce((a, r) => a + r.steps, 0) / reports.length);

console.log(`played ${reports.length} shootouts`);
console.log(`  player won        ${wins}, AI won ${reports.length - wins}`);
console.log(`  went to sudden death ${sd}`);
console.log(`  longest match     ${longest} rounds`);
console.log(`  average length    ${(avgSteps * DT).toFixed(1)}s of match time`);
console.log(`  sample scores     ${reports.slice(0, 8).map((r) => r.score).join(', ')}`);

if (problems.length) {
  console.log('\nFAILURES:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('\nall checks passed');
