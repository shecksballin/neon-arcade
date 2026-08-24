// All player-visible strings for Neon Clumsy. Switching language = swapping
// this file's data; no UI literals live in game code.
export const STR = {
  title: "NEON CLUMSY",
  subtitle: "DON'T. STOP. MOVING.",
  nicknamePlaceholder: "Enter your nickname",
  nicknameDefault: "Clumsy",
  play: "PLAY",
  version: "Neon Clumsy v1.1",
  clickToLock: "Click to lock the mouse",
  loading: "WRAPPING THE MUMMIES...",
  loadFailed: "Something snapped. Refresh to retry.",

  controlsTitle: "HOW TO PLAY",
  controlsRows: [
    ["W / A / S / D", "move"],
    ["W + SHIFT", "sprint (bump people!)"],
    ["MOUSE", "look"],
    ["SPACE", "jump"],
    ["SPACE x2", "dive"],
    ["ESC", "pause"],
  ],
  touchHint: "Left stick to move - drag right side to look",

  countdown3: "3",
  countdown2: "2",
  countdown1: "1",
  go: "GO!",

  playersLeft: "PLAYERS LEFT",
  layerLabel: "LAYER",
  // HUD chips are a micro-label over a value now (see index.html), so the
  // timer and the control hint need names of their own.
  timerLabel: "TIME",
  hudHintLabel: "CONTROLS",
  hudHint: "SHIFT sprint - SPACE jump - SPACE x2 dive",
  // The top-right standings card. Tiles broken is Clumsy's only score, so it
  // is the column the board ranks on (see setLeaderboard in ui.js).
  leaderboardTitle: "LEADERBOARD",
  leaderboardUnit: "TILES",

  elimFeed: "{name} took a slime bath",
  eliminatedTitle: "ELIMINATED",
  eliminatedPlace: "#{place} OF {total}",
  spectate: "SPECTATE",
  playAgain: "PLAY AGAIN",
  exit: "EXIT",
  spectating: "SPECTATING: {name}",
  spectateHint: "CLICK to cycle - ESC for menu",

  crowned: "CROWNED!",
  youWin: "YOU WIN",
  winnerIs: "{name} WINS",
  statTiles: "TILES BROKEN",
  statBumps: "PLAYERS BUMPED",
  statTime: "SURVIVAL TIME",

  paused: "PAUSED",
  backToGame: "BACK TO GAME",
  muted: "SOUND OFF",
  unmuted: "SOUND ON",

  billboard1: "NEON CLUMSY",
  billboard2: "DON'T STOP MOVING",
  billboard3: "MIND THE GAP",

  botNames: ["Wrappy", "Tut", "Bandito", "Gauze", "Sarco", "Pharaoh Phil",
             "Linen", "Cleo", "Dusty", "Scarab", "Mumbles"],
};
