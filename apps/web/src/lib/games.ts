/**
 * GAME CATALOG — the one place that knows what each game IS
 * =========================================================
 * Before this existed, the library grid in App.tsx hard-coded nine
 * <MagicBentoGameTile> elements and nothing else in the app had any idea
 * what kind of game any of them were. Two features needed that knowledge at
 * the same time — the category filter and the mobile allow-list — so the
 * facts live here once and both read from them.
 *
 * The `categories` on each entry are not decoration: they were read off the
 * server's own matchmaking config, not guessed from the titles.
 *
 *   1v1   apps/server/src/socket/games/{chess,connect,volley}.ts and
 *         LOBBY_GAME_MODES in games/lobbyGames.ts (golf/clumsy: 2 players,
 *         pugshooter duel/duo: 2) — plus trivia's '1v1' mode.
 *   ffa   the permanent free-play worlds (socket/freeplay/{cells,asteroids}
 *         World.ts), trivia's 'ffa' mode (FFA_MAX_PLAYERS = 100) and pug
 *         shooter's 'ffa'.
 *
 * `mobile` is a DELIBERATELY SHORT LIST, and it is not a guess either. It
 * means "playable with a thumb on a 390px-wide portrait screen", so a game
 * qualifies only if it needs no keyboard, no precise aiming and no large
 * viewport. That is Connect, Chess and Volley — the two turn-based boards
 * plus the one action game whose entire control surface is "move left/right",
 * which touch drag handles fine. Everything else is keyboard-driven
 * (Asteroids, Clumsy), needs mouse-precision aim (Pug Shooter, Golf), or is a
 * heavy 3D world that a phone GPU should not be asked to run.
 *
 * Games NOT in that list are hidden outright from touch devices rather than
 * shown-and-disabled: a tile you cannot play is worse than no tile. See
 * `useIsMobile` for what counts as a touch device, and note the ?mobile=
 * override there for testing this on a desktop.
 */

/** Every game view App.tsx can route to. Mirrors the `View` union there. */
export type GameId =
  | "neonconnect"
  | "chess"
  | "volley"
  | "cells"
  | "asteroids"
  | "trivia"
  | "golf"
  | "clumsy"
  | "pugshooter";

/**
 * Filter facets. A game carries every tag that is true of it, so tiles show
 * up under more than one filter (Chess is both `board` and `1v1`) — these are
 * tags, not a single taxonomy.
 */
export type GameCategory =
  | "board"
  | "1v1"
  | "ffa"
  | "action"
  | "quiz"
  | "mobile";

export interface GameMeta {
  id: GameId;
  title: string;
  /** One line for the tile / filter empty-state. */
  blurb: string;
  categories: GameCategory[];
  /** Playable by touch on a phone. Drives the mobile allow-list. */
  mobile: boolean;
}

export const GAMES: GameMeta[] = [
  {
    id: "neonconnect",
    title: "Neon Connect",
    blurb: "Four in a row, best of nerve",
    categories: ["board", "1v1", "mobile"],
    mobile: true,
  },
  {
    id: "chess",
    title: "Neon Chess",
    blurb: "Classical chess, neon rules",
    categories: ["board", "1v1", "mobile"],
    mobile: true,
  },
  {
    id: "volley",
    title: "Neon Volley",
    blurb: "Two paddles, one rally",
    categories: ["action", "1v1", "mobile"],
    mobile: true,
  },
  {
    id: "cells",
    title: "Neon Cells",
    blurb: "Eat, grow, outlast the lobby",
    categories: ["action", "ffa"],
    mobile: false,
  },
  {
    id: "asteroids",
    title: "Neon Asteroids",
    blurb: "Last ship flying wins",
    categories: ["action", "ffa"],
    mobile: false,
  },
  {
    id: "trivia",
    title: "Neon Quiz",
    blurb: "Fastest right answer takes it",
    categories: ["quiz", "1v1", "ffa"],
    mobile: false,
  },
  {
    id: "golf",
    title: "Neon Golf Clash",
    blurb: "Precision shots, neon greens",
    categories: ["action", "1v1"],
    mobile: false,
  },
  {
    id: "clumsy",
    title: "Neon Clumsy",
    blurb: "Ragdoll chaos to the finish",
    categories: ["action", "1v1"],
    mobile: false,
  },
  {
    id: "pugshooter",
    title: "Neon Pug Shooter",
    blurb: "Arena FPS with a bite",
    categories: ["action", "ffa", "1v1"],
    mobile: false,
  },
];

/**
 * Filter pills, in display order. `null` is the "All" pill — kept in the same
 * list rather than special-cased in the UI so the strip is one `.map()`.
 *
 * `mobile` is filtered OUT of the strip on touch devices by the library: when
 * every visible tile is already mobile-compatible, a "Mobile" pill that
 * changes nothing is just noise.
 */
export const GAME_FILTERS: { id: GameCategory | null; label: string }[] = [
  { id: null, label: "All Games" },
  { id: "board", label: "Board Games" },
  { id: "1v1", label: "1v1" },
  { id: "ffa", label: "Free For All" },
  { id: "action", label: "Action" },
  { id: "quiz", label: "Quiz" },
  { id: "mobile", label: "Mobile" },
];

/** Title lookup for the nav/sidebar header, keyed by the App.tsx view name. */
export const GAME_TITLES: Record<GameId, string> = GAMES.reduce(
  (acc, g) => {
    acc[g.id] = g.title;
    return acc;
  },
  {} as Record<GameId, string>,
);

/**
 * Is this destination allowed on a touch device?
 *
 * Takes any view name, not just a GameId, because App.tsx's navigation funnel
 * is typed on its whole `View` union — "landing", "arcade" and
 * "account_setup" are not games and must always pass.
 */
export function isPlayableOnMobile(view: string): boolean {
  const game = GAMES.find((g) => g.id === view);
  return game ? game.mobile : true;
}

/**
 * The library grid's contents for a given device + filter.
 *
 * Device gating happens FIRST and is not user-overridable: a phone never sees
 * a PC-only tile, whatever filter is selected. The filter then narrows what
 * is left.
 */
export function visibleGames(opts: {
  isMobile: boolean;
  filter: GameCategory | null;
}): GameMeta[] {
  const forDevice = opts.isMobile ? GAMES.filter((g) => g.mobile) : GAMES;
  if (!opts.filter) return forDevice;
  return forDevice.filter((g) => g.categories.includes(opts.filter!));
}
