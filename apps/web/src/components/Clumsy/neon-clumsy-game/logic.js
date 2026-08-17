// Neon Clumsy is a solo (player vs local AI) game - this is the platform's
// required rules-module stub; all gameplay runs client-side in index.html.
export const meta = { game: "neon-clumsy", minPlayers: 1, maxPlayers: 1 };
export function setup() { return {}; }
export function validateAction() { return { ok: true }; }
export function applyAction(state) { return state; }
export function isGameOver() { return { over: false }; }
export function viewFor(state) { return state; }
