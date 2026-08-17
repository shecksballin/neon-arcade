// Bot brains: seek healthy tile clusters, hop layers when their island
// shrinks, and occasionally sprint-bump the nearest victim. Three skill
// tiers come from CFG.botTiers.
import { CFG } from "./config.js";
import { PSTATE } from "./pawn.js";

export class BotBrain {
  constructor(pawn, tier, level, rng) {
    this.pawn = pawn;
    this.tier = tier;
    this.level = level;
    this.rng = rng;
    this.replanT = rng() * tier.replan;
    this.target = null;         // {x, z}
    this.victim = null;         // pawn to bump
    this.victimT = 0;
    this.jumpAsk = false;
    this.diveAsk = false;
    this.wantJumpAt = 0;
  }

  _currentLayer() {
    const p = this.pawn;
    return p.grounded ? p.layer
      : Math.max(0, Math.min(CFG.layers - 1, Math.floor(p.pos.y / CFG.layerGap)));
  }

  _replan(pawns) {
    const p = this.pawn;
    const L = this._currentLayer();
    this.victim = null;

    // aggression roll: hunt the nearest other pawn on our layer
    if (this.rng() < this.tier.bump) {
      let best = null, bd = 4.2;
      for (const o of pawns) {
        if (o === p || !o.alive || o.state === PSTATE.RAGDOLL) continue;
        if (Math.abs(o.pos.y - p.pos.y) > 1.4) continue;
        const d = Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z);
        if (d < bd) { bd = d; best = o; }
      }
      if (best) {
        this.victim = best;
        this.victimT = 1.6;
        return;
      }
    }

    // tile target: healthiest cluster nearby on this layer
    const layer = this.level.layers[L];
    const here = this.level.worldToHex(p.pos.x, p.pos.z);
    const hereIdx = this.level.tileIndex.get(here.q + "," + here.r);
    const cand = [];
    for (let i = 0; i < this.level.tiles.length; i++) {
      const st = layer.state[i];
      if (st !== 0 && st !== 1) continue;
      const t = this.level.tiles[i];
      const hd = hereIdx === undefined ? 3 :
        (Math.abs(t.q - here.q) + Math.abs(t.q + t.r - here.q - here.r) + Math.abs(t.r - here.r)) / 2;
      if (hd > 6) continue;
      let ns = 0;
      for (const n of this.level.neighbors[i]) {
        const s = layer.state[n];
        if (s === 0) ns++;
      }
      cand.push({ t, score: ns * 1.25 - hd * 0.4 + this.rng() * 1.6, hd });
    }
    if (!cand.length) { this.target = { x: 0, z: 0 }; return; }
    let pick;
    if (this.rng() < this.tier.mistake) {
      pick = cand[Math.floor(this.rng() * cand.length)];
    } else {
      cand.sort((a, b) => b.score - a.score);
      pick = cand[Math.floor(this.rng() * Math.min(3, cand.length))];
    }
    this.target = {
      x: pick.t.x + (this.rng() - 0.5) * 0.7,
      z: pick.t.z + (this.rng() - 0.5) * 0.7,
    };
    // hop if the pick is a gap away
    this.jumpAsk = pick.hd >= 2 && this.rng() < 0.65;
  }

  update(dt, pawns) {
    const p = this.pawn;
    const out = { mx: 0, mz: 0, sprint: false, jump: false, dive: false,
                  turnDir: 0, speedMul: this.tier.speed };
    if (!p.alive || p.locked) return out;

    this.replanT -= dt;
    this.victimT -= dt;

    // urgent replan when our tile starts wobbling
    if (p.grounded) {
      const idx = this.level.solidAt(p.layer, p.pos.x, p.pos.z);
      if (idx !== -1 && this.level.layers[p.layer].state[idx] === 1 && this.replanT > 0.12) {
        this.replanT = 0;
      }
    }
    if (this.replanT <= 0) {
      this.replanT = this.tier.replan * (0.8 + this.rng() * 0.5);
      this._replan(pawns);
    }

    let tx, tz, sprint = false;
    if (this.victim && this.victim.alive && this.victimT > 0) {
      tx = this.victim.pos.x; tz = this.victim.pos.z;
      sprint = true;
    } else if (this.target) {
      tx = this.target.x; tz = this.target.z;
    } else {
      return out;
    }

    const dx = tx - p.pos.x, dz = tz - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.25) {
      out.mx = dx / d; out.mz = dz / d;
      out.sprint = sprint || d > 3.0;
    } else if (!this.victim) {
      this.replanT = Math.min(this.replanT, 0.15);
    }

    // jumping across gaps / celebratory hops
    if (p.grounded && this.jumpAsk && d > 1.6 && d < 4.2) {
      out.jump = true;
      this.jumpAsk = false;
      this.diveAsk = this.rng() < this.tier.dive;
    }
    if (!p.grounded && this.diveAsk && p.jumped && !p.dived && p.vel.y < 1.2) {
      out.dive = true;
      this.diveAsk = false;
    }
    return out;
  }
}
