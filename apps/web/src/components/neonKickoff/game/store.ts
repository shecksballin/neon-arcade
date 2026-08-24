import * as THREE from 'three';
import { create } from 'zustand';
import { aiKeeperGuess, aiStrikerPlan } from './ai';
import * as sfx from './audio';
import { loadSfx, setSfxMuted } from './sfx';
import { makeFlight } from './flight';
import { loadBoard, saveMatch, type BoardEntry } from './leaderboard';
import { ringZone } from './ring';
import {
  createShootout,
  inSuddenDeath,
  nextKicker,
  recordKick,
  roundNumber,
  type ShootoutState,
} from './shootout';
import { flipDir, type Dir, type KickData, type Phase, type Side, type Zone } from './types';

/** seconds between the AI striker's wind-up animation starting and boot-on-ball */
export const KICK_CONTACT = 0.95;
const INTRO_SECONDS = 1.9;
const RESULT_SECONDS = 2.4;

/**
 * Frame-driven clocks, mutated in useFrame and never passed through set() —
 * pausing stops the ticker, which freezes every timer in the game for free.
 */
export interface Clock {
  intro: number;
  aim: number;    // seconds spent waiting on the ring (drives its acceleration)
  cycle: number;  // ring cycle phase [0,1) — 0 big/red, 1 smallest/green
  guard: number;
  windupAt: number;
  flight: number;
  flightTotal: number;
  flightCross: number;
  /** has the boot met the ball yet — gates the kick sound and the launch */
  booted: boolean;
  /** has the keeper got a glove to it yet — gates the save sound */
  parried: boolean;
  result: number;
}

export interface ResultInfo {
  title: string;
  sub: string;
  /** from the player's point of view */
  good: boolean;
  zone: Zone | null; // player's strike timing, for the PERFECT/SCUFFED chip
}

/** Everything the ONLINE bridge needs. Practice leaves this null. */
export interface OnlineState {
  gameId: string;
  mySide: 1 | 2;
  opponent: string;
  /** Sent my strike, waiting on the server's resolved kick (ring freezes). */
  awaiting: boolean;
  /** Server-declared next attempt, applied when the result banner ends. */
  pendingNext: { myKick: boolean; round: number; suddenDeath: boolean } | null;
  /**
   * The server's authoritative kick arrays for the kick IN FLIGHT — applied
   * to the visible shootout only when the ball lands (resolveKick), never at
   * receipt: the HUD pips read the shootout live, and flipping them the
   * moment the payload arrived spoiled every outcome ~3s before the theatre
   * played it.
   */
  pendingKicks: { player: boolean[]; ai: boolean[] } | null;
  /** Server-declared end, applied after the final kick's banner. */
  ended: { won: boolean; reason: string } | null;
  emitStrike: (dir: Dir, zone: Zone) => void;
  emitGuess: (dir: Dir) => void;
}

interface GameStore {
  screen: 'menu' | 'game';
  phase: Phase;
  paused: boolean;
  muted: boolean;
  /** 'practice' plays the built-in AI; 'online' defers every outcome to the
   *  server (see wrapper NeonKickoffGame). */
  mode: 'practice' | 'online';
  online: OnlineState | null;
  /** Injected by the arcade wrapper: where an ONLINE quit lands (its lobby).
   *  Practice quits go to the game's own menu screen instead. */
  wrapperExit: (() => void) | null;

  shootout: ShootoutState;
  turn: Side;
  round: number;
  suddenDeath: boolean;

  kick: KickData | null;
  aiPlan: { dir: Dir; zone: Zone } | null;
  playerGuess: Dir;
  windup: boolean;
  result: ResultInfo | null;

  history: Dir[]; // player's chosen corners, feeds the AI keeper's read
  stats: { perfect: number; saves: number };
  board: BoardEntry[];
  recorded: boolean;

  clock: Clock;
  /** scratch state written by the scene every frame, read by the camera rig */
  live: { ball: THREE.Vector3 };

  startMatch(): void;
  /** Seat this client in a server shootout. p1 kicks first (mySide 1). */
  startOnlineMatch(args: {
    gameId: string;
    mySide: 1 | 2;
    opponent: string;
    emitStrike: (dir: Dir, zone: Zone) => void;
    emitGuess: (dir: Dir) => void;
  }): void;
  /** Server-resolved kick (either kicker) — plays the flight verbatim. */
  onlineServerKick(k: {
    kicker: 1 | 2;
    dir: Dir;
    zone: Zone;
    guess: Dir;
    outcome: 'goal' | 'saved' | 'off';
    kicks: { p1: boolean[]; p2: boolean[] };
    next: { kicker: 1 | 2; round: number; suddenDeath: boolean } | null;
  }): void;
  /** Server-declared end (decided or forfeit). */
  onlineServerEnded(e: { won: boolean; reason: string }): void;
  togglePause(): void;
  /** Exit-guard hook: end the shootout NOW as a loss (walked away). */
  forfeitMatch(): void;
  toggleMute(): void;
  quitToMenu(): void;
  introDone(): void;
  strikerKick(dir: Dir): void;
  setGuess(dir: Dir): void;
  windupStart(): void;
  aiKick(): void;
  resolveKick(): void;
  nextAfterResult(): void;
}

function freshClock(): Clock {
  return {
    intro: 0,
    aim: 0,
    cycle: 0,
    guard: 0,
    windupAt: 0,
    flight: 0,
    flightTotal: 0,
    flightCross: 0,
    booted: false,
    parried: false,
    result: 0,
  };
}

function resetClock(c: Clock) {
  Object.assign(c, freshClock());
}

const DIR_LABEL: Record<Dir, string> = {
  left: 'to the left',
  middle: 'down the middle',
  right: 'to the right',
};

function playerKickResult(kick: KickData): ResultInfo {
  if (kick.outcome === 'off') {
    return {
      title: 'OVER THE BAR!',
      sub: 'Mistimed — you leaned back and skied it',
      good: false,
      zone: kick.zone,
    };
  }
  if (kick.outcome === 'saved') {
    return {
      title: 'SAVED!',
      sub:
        kick.guess === 'middle'
          ? 'The keeper stood tall and read it'
          : 'The keeper guessed right and got across',
      good: false,
      zone: kick.zone,
    };
  }
  return {
    title: 'GOAL!',
    sub:
      kick.zone === 'orange'
        ? 'Scuffed it… but the keeper went the wrong way'
        : `Buried ${DIR_LABEL[kick.dir]} — keeper sent the wrong way`,
    good: true,
    zone: kick.zone,
  };
}

function aiKickResult(kick: KickData): ResultInfo {
  if (kick.outcome === 'off') {
    return { title: 'SKIED IT!', sub: 'The AI blazed it over the bar', good: true, zone: null };
  }
  if (kick.outcome === 'saved') {
    return {
      title: 'WHAT A SAVE!',
      sub:
        kick.guess === 'middle'
          ? 'You stood your ground and caught it clean'
          : `Full stretch ${flipDir(kick.guess) === 'left' ? 'to your left' : 'to your right'}!`,
      good: true,
      zone: null,
    };
  }
  return {
    title: 'AI SCORES',
    sub:
      kick.guess === kick.dir
        ? 'It squeezed past you'
        : `You dove ${flipDir(kick.guess) === 'middle' ? 'nowhere' : 'to your ' + flipDir(kick.guess)}, the shot went ${DIR_LABEL[kick.dir]}`,
    good: false,
    zone: null,
  };
}

export const useGame = create<GameStore>()((set, get) => ({
  screen: 'menu',
  phase: 'intro',
  paused: false,
  muted: false,
  mode: 'practice',
  online: null,
  wrapperExit: null,

  shootout: createShootout(),
  turn: 'player',
  round: 1,
  suddenDeath: false,

  kick: null,
  aiPlan: null,
  playerGuess: 'middle',
  windup: false,
  result: null,

  history: [],
  stats: { perfect: 0, saves: 0 },
  board: loadBoard(),
  recorded: false,

  clock: freshClock(),
  live: { ball: new THREE.Vector3(0, 0.111, 11) },

  startMatch() {
    resetClock(get().clock);
    set({
      mode: 'practice',
      online: null,
      screen: 'game',
      phase: 'intro',
      paused: false,
      shootout: createShootout(),
      turn: 'player',
      round: 1,
      suddenDeath: false,
      kick: null,
      aiPlan: null,
      playerGuess: 'middle',
      windup: false,
      result: null,
      history: [],
      stats: { perfect: 0, saves: 0 },
      recorded: false,
    });
    loadSfx();
    sfx.whistle();
  },

  startOnlineMatch(args) {
    resetClock(get().clock);
    set({
      mode: 'online',
      online: {
        gameId: args.gameId,
        mySide: args.mySide,
        opponent: args.opponent,
        awaiting: false,
        pendingNext: null,
        pendingKicks: null,
        ended: null,
      emitStrike: args.emitStrike,
        emitGuess: args.emitGuess,
      },
      screen: 'game',
      phase: 'intro',
      paused: false,
      shootout: createShootout(),
      // p1 kicks first; 'player' always means THIS client in scene terms.
      turn: args.mySide === 1 ? 'player' : 'ai',
      round: 1,
      suddenDeath: false,
      kick: null,
      aiPlan: null,
      playerGuess: 'middle',
      windup: false,
      result: null,
      history: [],
      stats: { perfect: 0, saves: 0 },
      recorded: true, // online never writes the local practice board
    });
    loadSfx();
    sfx.whistle();
  },

  onlineServerKick(k) {
    const g = get();
    const online = g.online;
    if (g.mode !== 'online' || !online) return;
    const mine = k.kicker === online.mySide;
    const kick: KickData = {
      kicker: mine ? 'player' : 'ai',
      dir: k.dir,
      zone: k.zone,
      outcome: k.outcome,
      guess: k.guess,
    };
    const path = makeFlight(kick);
    // Both seats watch the same run-up: the striker model sprints in during
    // the negative window, boot meets ball at t=0 — which also hides the
    // server round-trip entirely.
    g.clock.flight = -KICK_CONTACT;
    g.clock.flightTotal = path.total;
    g.clock.flightCross = path.cross;
    g.clock.booted = false;
    g.clock.parried = false;
    // The server's arrays ARE the shootout — but they are STASHED here and
    // applied in resolveKick, when the ball actually lands. Stats bumps ride
    // the same delay for the same reason (the HUD reads them live).
    const myKicks = online.mySide === 1 ? k.kicks.p1 : k.kicks.p2;
    const theirKicks = online.mySide === 1 ? k.kicks.p2 : k.kicks.p1;
    set({
      phase: 'strike',
      kick,
      windup: false,
      online: {
        ...online,
        awaiting: false,
        pendingKicks: { player: myKicks, ai: theirKicks },
        pendingNext: k.next
          ? {
              myKick: k.next.kicker === online.mySide,
              round: k.next.round,
              suddenDeath: k.next.suddenDeath,
            }
          : null,
      },
    });
  },

  onlineServerEnded(e) {
    const g = get();
    if (g.mode !== 'online' || !g.online) return;
    // Mid-flight/banner: park it — nextAfterResult applies it after the
    // banner. Any other phase (forfeit while aiming, opponent dropped):
    // jump straight to the final whistle.
    const ended = { won: e.won, reason: e.reason };
    // A FORFEIT ends the theatre too — there is no kick left to land, and
    // the leaver's exit guard is waiting on phase 'over'. Everything else
    // parks until the in-flight kick's banner ends; `paused: false` because
    // a parked ending could otherwise never be reached from a paused game
    // (the ticker is what applies it, and pausing stops the ticker).
    if (e.reason !== 'forfeit' && (g.phase === 'strike' || g.phase === 'result')) {
      set({ online: { ...g.online, ended }, paused: false });
      return;
    }
    set({
      online: { ...g.online, ended },
      phase: 'over',
      paused: false,
      shootout: { ...g.shootout, winner: e.won ? 'player' : 'ai' },
    });
  },

  togglePause() {
    const g = get();
    if (g.screen !== 'game' || g.phase === 'over') return;
    set({ paused: !g.paused });
  },

  forfeitMatch() {
    const g = get();
    if (g.screen !== 'game' || g.phase === 'over') return;
    // Walking away mid-shootout is a loss, full stop. The shootout is
    // stamped with the opponent as winner and the ordinary results screen
    // shows the defeat - the exit guard then chains progression + leaves.
    set({
      phase: 'over',
      paused: false,
      shootout: { ...g.shootout, winner: 'ai' },
      recorded: true, // a forfeit never lands on the local best-runs board
    });
  },

  toggleMute() {
    const muted = !get().muted;
    sfx.setMuted(muted);
    setSfxMuted(muted);
    set({ muted });
  },

  quitToMenu() {
    // Reset the MODE too: a stale mode:'online' surviving into the next
    // visit made StrictMode's unmount probe look like a live match (and
    // suppressed practice results). The menu is always practice's door.
    set({ screen: 'menu', paused: false, mode: 'practice', online: null });
  },

  introDone() {
    const g = get();
    resetClock(g.clock);
    if (g.turn === 'player') {
      set({ phase: 'aim' });
    } else if (g.mode === 'online') {
      // A HUMAN is striking: no scripted windup, no AI plan — the windup
      // plays when their resolved kick arrives (onlineServerKick). Infinity
      // keeps tick.ts's guard timers inert.
      g.clock.windupAt = Infinity;
      set({ phase: 'guard', aiPlan: null, playerGuess: 'middle', windup: false });
    } else {
      g.clock.windupAt = 1.3 + Math.random() * 2.1;
      set({ phase: 'guard', aiPlan: aiStrikerPlan(), playerGuess: 'middle', windup: false });
    }
  },

  strikerKick(dir) {
    const g = get();
    if (g.phase !== 'aim' || g.paused) return;
    const zone = ringZone(g.clock.cycle);
    if (g.mode === 'online' && g.online) {
      if (g.online.awaiting) return; // one strike per attempt
      g.online.emitStrike(dir, zone);
      // Freeze the ring (tick.ts skips 'aim' while awaiting) until the
      // server's resolved kick comes back and plays the real flight.
      set({ online: { ...g.online, awaiting: true } });
      return;
    }
    const guess = aiKeeperGuess(g.history);
    const outcome = zone === 'red' ? 'off' : guess === dir ? 'saved' : 'goal';
    const kick: KickData = { kicker: 'player', dir, zone, outcome, guess };
    const path = makeFlight(kick);
    // The striker is on camera now, so he has to run up and actually hit it: the
    // flight clock opens a run-up BEFORE zero, and makeFlight parks the ball on
    // the spot for any t <= 0.
    g.clock.flight = -KICK_CONTACT;
    g.clock.flightTotal = path.total;
    g.clock.flightCross = path.cross;
    g.clock.booted = false;
    g.clock.parried = false;
    set({
      phase: 'strike',
      kick,
      history: [...g.history, dir],
      stats: zone === 'green' ? { ...g.stats, perfect: g.stats.perfect + 1 } : g.stats,
    });
  },

  setGuess(dir) {
    const g = get();
    if (g.phase !== 'guard' || g.paused) return;
    if (g.mode === 'online') g.online?.emitGuess(dir);
    set({ playerGuess: dir });
  },

  windupStart() {
    if (get().phase !== 'guard') return;
    set({ windup: true });
  },

  aiKick() {
    const g = get();
    if (g.phase !== 'guard') return;
    const choice = g.aiPlan ?? aiStrikerPlan();
    const outcome =
      choice.zone === 'red' ? 'off' : g.playerGuess === choice.dir ? 'saved' : 'goal';
    const kick: KickData = {
      kicker: 'ai',
      dir: choice.dir,
      zone: choice.zone,
      outcome,
      guess: g.playerGuess,
    };
    const path = makeFlight(kick);
    // the AI's wind-up already ran during 'guard', so its boot lands right now
    g.clock.flight = 0;
    g.clock.flightTotal = path.total;
    g.clock.flightCross = path.cross;
    g.clock.booted = false;
    g.clock.parried = false;
    set({
      phase: 'strike',
      kick,
      stats: outcome === 'saved' ? { ...g.stats, saves: g.stats.saves + 1 } : g.stats,
    });
  },

  resolveKick() {
    const g = get();
    const kick = g.kick;
    if (g.phase !== 'strike' || !kick) return;
    // Online: the server's stashed arrays become visible NOW, as the ball
    // lands — recording locally would double-count, and applying at receipt
    // spoiled the outcome on the HUD mid-flight.
    const shootout =
      g.mode === 'online'
        ? g.online?.pendingKicks
          ? { kicks: g.online.pendingKicks, winner: null }
          : g.shootout
        : recordKick(g.shootout, kick.kicker, kick.outcome === 'goal');
    if (g.mode === 'online' && g.online) {
      const mine = kick.kicker === 'player';
      if (mine && kick.zone === 'green') {
        set({ stats: { ...g.stats, perfect: g.stats.perfect + 1 } });
      } else if (!mine && kick.outcome === 'saved') {
        set({ stats: { ...g.stats, saves: g.stats.saves + 1 } });
      }
      set({ online: { ...g.online, pendingKicks: null } });
    }
    const result = kick.kicker === 'player' ? playerKickResult(kick) : aiKickResult(kick);
    g.clock.result = 0;
    set({ phase: 'result', shootout, result });
    if (result.good) sfx.roar();
    else sfx.groan();
  },

  nextAfterResult() {
    const g = get();
    if (g.phase !== 'result') return;
    if (g.mode === 'online' && g.online) {
      if (g.online.ended) {
        set({
          phase: 'over',
          shootout: { ...g.shootout, winner: g.online.ended.won ? 'player' : 'ai' },
        });
        if (g.online.ended.won) sfx.roar();
        return;
      }
      const next = g.online.pendingNext;
      if (!next) return; // ended event is a beat behind the last kick — wait
      resetClock(g.clock);
      set({
        phase: 'intro',
        turn: next.myKick ? 'player' : 'ai',
        round: next.round,
        suddenDeath: next.suddenDeath,
        kick: null,
        result: null,
        windup: false,
        online: { ...g.online, pendingNext: null },
      });
      sfx.whistle();
      return;
    }
    if (g.shootout.winner) {
      let board = g.board;
      if (!g.recorded) {
        board = saveMatch({
          name: 'YOU',
          won: g.shootout.winner === 'player',
          score: `${g.shootout.kicks.player.filter(Boolean).length}–${g.shootout.kicks.ai.filter(Boolean).length}`,
          rounds: Math.max(g.shootout.kicks.player.length, g.shootout.kicks.ai.length),
          perfect: g.stats.perfect,
          saves: g.stats.saves,
          date: Date.now(),
        });
      }
      set({ phase: 'over', board, recorded: true });
      if (g.shootout.winner === 'player') sfx.roar();
      return;
    }
    resetClock(g.clock);
    set({
      phase: 'intro',
      turn: nextKicker(g.shootout),
      round: roundNumber(g.shootout),
      suddenDeath: inSuddenDeath(g.shootout),
      kick: null,
      result: null,
      windup: false,
    });
    sfx.whistle();
  },
}));

export { INTRO_SECONDS, RESULT_SECONDS };
