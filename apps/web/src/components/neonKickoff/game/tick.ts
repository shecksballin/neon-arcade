import { ringPeriod } from './ring';
import { playSfx } from './sfx';
import { INTRO_SECONDS, KICK_CONTACT, RESULT_SECONDS, useGame } from './store';

/**
 * The match clock: one step of every phase timer in the game.
 *
 * Kept out of the React component so it can be driven by something other than a
 * render loop — tools/simulate.ts plays whole shootouts through this at a fixed
 * timestep, with no browser involved.
 */
export function advance(rawDt: number) {
  const g = useGame.getState();
  if (g.screen !== 'game' || g.paused) return;
  const dt = Math.min(rawDt, 0.05);
  const c = g.clock;

  switch (g.phase) {
    case 'intro':
      c.intro += dt;
      if (c.intro >= INTRO_SECONDS) g.introDone();
      break;
    case 'aim':
      // Online: the strike is sent and the ring FREEZES on the timing the
      // player actually hit, until the server's resolved kick plays it out.
      if (g.online?.awaiting) break;
      c.aim += dt;
      c.cycle += dt / ringPeriod(c.aim);
      if (c.cycle >= 1) c.cycle -= 1;
      break;
    case 'guard':
      c.guard += dt;
      if (!g.windup && c.guard >= c.windupAt) g.windupStart();
      if (c.guard >= c.windupAt + KICK_CONTACT) g.aiKick();
      break;
    case 'strike':
      c.flight += dt;
      // boot meets ball at t=0 — before that the striker is still running up
      if (!c.booted && c.flight >= 0) {
        c.booted = true;
        playSfx('kick');
      }
      // and the keeper's glove reaches it as it arrives at the line, which is
      // where a save is decided — a beat the old sound missed by most of a
      // second, and only ever played for the AI's kicks
      if (!c.parried && c.flight >= c.flightCross && g.kick?.outcome === 'saved') {
        c.parried = true;
        playSfx('save');
      }
      if (c.flight >= c.flightTotal + 0.45) g.resolveKick();
      break;
    case 'result':
      c.result += dt;
      c.flight += dt; // let the ball finish rolling behind the banner
      if (c.result >= RESULT_SECONDS) g.nextAfterResult();
      break;
    case 'over':
      c.flight += dt;
      break;
  }
}
