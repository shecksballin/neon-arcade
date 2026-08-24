// DOM overlay UI. Every visible string comes from strings.js.
import { STR } from "./strings.js";

const $ = (id) => document.getElementById(id);

function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

export class UI {
  constructor() {
    this.els = {
      loading: $("loading"), loadBar: $("loadBar"), loadText: $("loadText"),
      loadLogo: $("loadLogo"),
      menu: $("menu"), menuLogo: $("menuLogo"), menuSub: $("menuSub"),
      nick: $("nick"), playBtn: $("playBtn"), controlsTitle: $("controlsTitle"),
      controlsRows: $("controlsRows"), versionLine: $("versionLine"),
      // HUD chips are label + value pairs (Asteroids-style), so the live
      // numbers go into the `*V` spans — never onto the chip itself, which
      // also holds the icon and the static `*K` label.
      hud: $("hud"), playersLeft: $("playersLeft"), layerMeter: $("layerMeter"),
      timer: $("timer"), hudHint: $("hudHint"), feed: $("feed"),
      leaderboardTitle: $("leaderboardTitle"), leaderboardUnit: $("leaderboardUnit"),
      leaderboardRows: $("leaderboardRows"),
      playersLeftK: $("playersLeftK"), playersLeftV: $("playersLeftV"),
      layerMeterK: $("layerMeterK"), layerMeterV: $("layerMeterV"),
      timerK: $("timerK"), timerV: $("timerV"),
      hudHintK: $("hudHintK"), hudHintText: $("hudHintText"),
      countdown: $("countdown"), countNum: $("countNum"),
      lockOverlay: $("lockOverlay"), lockText: $("lockText"),
      pause: $("pause"), pauseWord: $("pauseWord"), resumeBtn: $("resumeBtn"),
      end: $("end"), endTitle: $("endTitle"), endSub: $("endSub"),
      stTiles: $("stTiles"), stBumps: $("stBumps"), stTime: $("stTime"),
      stTilesK: $("stTilesK"), stBumpsK: $("stBumpsK"), stTimeK: $("stTimeK"),
      spectateBtn: $("spectateBtn"), againBtn: $("againBtn"),
      spectateBar: $("spectateBar"), muteBtn: $("muteBtn"),
      touchUI: $("touchUI"), btnJump: $("btnJump"), btnDive: $("btnDive"),
      btnSprint: $("btnSprint"), dev: $("dev"),
    };
    // Last rendered leaderboard, as a string — see setLeaderboard.
    this._lbSig = "";
    this._fillStatic();
  }

  _fillStatic() {
    const logoHtml = STR.title.split(" ").map((w, i) =>
      i % 2 ? `<span class="alt">${w}</span>` : w).join(" ");
    this.els.loadLogo.innerHTML = logoHtml;
    this.els.menuLogo.innerHTML = logoHtml;
    this.els.menuSub.textContent = STR.subtitle;
    this.els.loadText.textContent = STR.loading;
    this.els.nick.placeholder = STR.nicknamePlaceholder;
    this.els.playBtn.textContent = STR.play;
    this.els.controlsTitle.textContent = STR.controlsTitle;
    this.els.controlsRows.innerHTML = STR.controlsRows
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
    this.els.versionLine.textContent = STR.version;
    this.els.lockText.textContent = STR.clickToLock;
    this.els.pauseWord.textContent = STR.paused;
    this.els.resumeBtn.textContent = STR.backToGame;
    this.els.spectateBtn.textContent = STR.spectate;
    this.els.againBtn.textContent = STR.playAgain;
    this.els.stTilesK.textContent = STR.statTiles;
    this.els.stBumpsK.textContent = STR.statBumps;
    this.els.stTimeK.textContent = STR.statTime;
    this.els.muteBtn.textContent = STR.unmuted;
    this.els.btnJump.textContent = "JUMP";
    this.els.btnDive.textContent = "DIVE";
    this.els.btnSprint.textContent = "SPRINT";
    this.els.playersLeftK.textContent = STR.playersLeft;
    this.els.layerMeterK.textContent = STR.layerLabel;
    this.els.timerK.textContent = STR.timerLabel;
    this.els.hudHintK.textContent = STR.hudHintLabel;
    this.els.hudHintText.textContent = STR.hudHint;
    this.els.leaderboardTitle.textContent = STR.leaderboardTitle;
    this.els.leaderboardUnit.textContent = STR.leaderboardUnit;
  }

  show(name, on = true) { this.els[name].classList.toggle("hidden", !on); }

  loadingProgress(k) {
    this.els.loadBar.style.width = Math.round(k * 100) + "%";
  }
  loadingFailed() { this.els.loadText.textContent = STR.loadFailed; }

  showMenu() {
    this.show("loading", false);
    this.show("menu", true);
    this.show("hud", false);
    this.show("end", false);
    this.show("countdown", false);
    this.show("spectateBar", false);
    if (!this.els.nick.value) this.els.nick.value = STR.nicknameDefault;
  }

  startRound() {
    this.show("menu", false);
    this.show("end", false);
    this.show("hud", true);
    this.show("spectateBar", false);
    this.els.feed.innerHTML = "";
    this.els.leaderboardRows.replaceChildren();
    this._lbSig = "";
  }

  countdown(txt) {
    this.show("countdown", txt !== null);
    if (txt !== null) {
      this.els.countNum.textContent = txt;
      this.els.countNum.style.animation = "none";
      void this.els.countNum.offsetWidth;
      this.els.countNum.style.animation = "feedIn .3s ease";
    }
  }

  setPlayersLeft(n) { this.els.playersLeftV.textContent = `${n}`; }
  setLayer(n, total) { this.els.layerMeterV.textContent = `${n} / ${total}`; }
  setTimer(t) {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    this.els.timerV.textContent = `${m}:${String(s).padStart(2, "0")}`;
  }

  /**
   * The top-right standings board. `rows` is already sorted and sliced by the
   * caller (game.js leaderboardRows): { name, value, isPlayer }.
   *
   * The game loop calls this ~8x a second, so a change SIGNATURE guards the
   * rebuild — without it every tick would throw away and re-parse a dozen
   * nodes to redraw numbers that had not moved (the same trick the pug HUD's
   * lbSignature plays). Rows only actually change when a tile breaks or
   * somebody falls out.
   *
   * Names are user-controlled — the arcade profile name rides in on `?name=`
   * and lands in the nick field — so every one goes in through textContent.
   * There is no string-interpolated HTML on this path, ever.
   */
  setLeaderboard(rows) {
    const sig = rows.map((r) => `${r.name}:${r.value}:${r.isPlayer ? 1 : 0}`).join("|");
    if (sig === this._lbSig) return;
    this._lbSig = sig;
    const built = rows.map((r, i) => {
      const row = document.createElement("div");
      row.className = r.isPlayer ? "lb-row me" : "lb-row";
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = `#${i + 1}`;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name;
      const value = document.createElement("span");
      value.className = "v";
      value.textContent = `${r.value}`;
      row.append(rank, name, value);
      return row;
    });
    this.els.leaderboardRows.replaceChildren(...built);
  }

  feed(name) {
    const div = document.createElement("div");
    div.className = "feedMsg";
    div.textContent = fmt(STR.elimFeed, { name });
    this.els.feed.appendChild(div);
    while (this.els.feed.children.length > 4) this.els.feed.firstChild.remove();
    setTimeout(() => div.remove(), 3400);
  }

  showEnd({ win, winnerName, place, total, stats }) {
    this.show("end", true);
    this.show("spectateBar", false);
    this.els.endTitle.classList.toggle("lose", !win);
    if (win) {
      this.els.endTitle.textContent = STR.crowned;
      this.els.endSub.textContent = STR.youWin;
    } else if (winnerName) {
      this.els.endTitle.textContent = fmt(STR.eliminatedPlace, { place, total });
      this.els.endSub.textContent = fmt(STR.winnerIs, { name: winnerName });
    } else {
      this.els.endTitle.textContent = STR.eliminatedTitle;
      this.els.endSub.textContent = fmt(STR.eliminatedPlace, { place, total });
    }
    this.els.stTiles.textContent = stats.tiles;
    this.els.stBumps.textContent = stats.bumps;
    const m = Math.floor(stats.time / 60), s = Math.floor(stats.time % 60);
    this.els.stTime.textContent = `${m}:${String(s).padStart(2, "0")}`;
    this.els.spectateBtn.style.display = winnerName ? "none" : "";
  }

  spectating(name) {
    this.show("spectateBar", name !== null);
    if (name !== null) {
      this.els.spectateBar.innerHTML =
        `${fmt(STR.spectating, { name })}<small>${STR.spectateHint}</small>`;
    }
  }

  setMuted(m) { this.els.muteBtn.textContent = m ? STR.muted : STR.unmuted; }

  bind({ onPlay, onAgain, onSpectate, onResume, onMute }) {
    this.els.playBtn.onclick = onPlay;
    this.els.againBtn.onclick = onAgain;
    this.els.spectateBtn.onclick = onSpectate;
    this.els.resumeBtn.onclick = onResume;
    this.els.muteBtn.onclick = onMute;
  }

  nickname() {
    const v = this.els.nick.value.trim();
    return v.length >= 2 ? v.slice(0, 14) : STR.nicknameDefault;
  }
}
