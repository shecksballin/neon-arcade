/**
 * PRIVATE WAGER — THE CATALOG (a leaf, on purpose)
 * ================================================
 * Every (gameKey, mode) pair a private room can host, plus the four lookups
 * that turn one into human copy. This used to live inside
 * `PrivateWagerInvite.tsx`, which is fine for the pickers but not for anything
 * else: that file static-imports the Cells and Asteroids difficulty selectors
 * (it renders each game's own mode picker inside the invite flow), so ANY
 * module that wanted to label an invite — the nav-bar notification centre, a
 * toast, the sidebar's JOIN button — dragged ~35 kB of game-directory code
 * into the entry chunk with it.
 *
 * So the table lives here, where the only import is `type`-level. Import this
 * module to READ the catalog; import PrivateWagerInvite.tsx to RENDER a
 * picker. (PrivateWagerInvite re-exports everything below, so nothing that
 * already imported it from there had to change.)
 *
 * ‼️ This table mirrors `CATALOG` in
 * apps/server/src/socket/games/privateMatch.ts. If the server rejects a pair
 * it answers `private:error { code:'bad_mode' }`, so the two must stay in
 * sync — the UI must never offer something the server will refuse.
 *
 * Cells/Asteroids FREE PLAY is deliberately absent: the contract excludes it
 * from private wager (a permanent drop-in world has no match to start).
 */

export type PrivateGameKey =
  | 'chess'
  | 'connect'
  | 'volley'
  | 'kickoff'
  | 'cells'
  | 'asteroids'
  | 'golf'
  | 'clumsy'
  | 'pugshooter';

export interface PrivateWagerMode {
  /** The wire value sent as `mode` — must match the server catalog exactly. */
  id: string;
  label: string;
  hint?: string;
  /** Seats the server gives this room. 2 = the 1v1 diagonal waiting-room. */
  capacity: number;
  /** Players REQUIRED to start (server minPlayers). Only strict team modes
   *  set it — pugshooter duo needs exactly 4; everything else starts at 2. */
  minPlayers?: number;
}

export interface PrivateWagerGame {
  key: PrivateGameKey;
  /** Headline copy, e.g. "NEON CHESS". */
  title: string;
  modes: PrivateWagerMode[];
}

export const PRIVATE_WAGER_GAMES: PrivateWagerGame[] = [
  {
    key: 'chess',
    title: 'Neon Chess',
    modes: [{ id: '1v1', label: 'Duel', hint: 'one on one', capacity: 2 }],
  },
  {
    key: 'connect',
    title: 'Neon Connect',
    modes: [{ id: '1v1', label: 'Duel', hint: 'one on one', capacity: 2 }],
  },
  {
    key: 'volley',
    title: 'Neon Volley',
    modes: [
      { id: 'classic', label: '11 Points', hint: 'classic regulation', capacity: 2 },
      { id: 'bestof3', label: 'Best of 3', hint: 'three sets', capacity: 2 },
      { id: 'sudden', label: 'Sudden Death', hint: 'first point wins', capacity: 2 },
    ],
  },
  {
    key: 'kickoff',
    title: 'Neon Kickoff',
    modes: [
      { id: '1v1', label: 'Shootout', hint: 'best of five from the spot', capacity: 2 },
    ],
  },
  // Cells + Asteroids are a 2×2: sector (ECLIPSE|BLITZ) × mode
  // (SLAYER|LAST MAN STANDING), exactly the four options their lobbies offer.
  // The id is the `sector:mode` composite — the same key the public queue uses
  // and the same key the server catalog is keyed by, so an ECLIPSE·SLAYER
  // room can never start a BLITZ·LMS match.
  //
  // ‼️ These two entries are NOT rendered as a flat list: the invite picker
  // renders the practice sector drill-down for them (see
  // SECTOR_DRILLDOWN_GAMES in PrivateWagerInvite.tsx). They stay in the
  // catalog because the room header and the invite notifications resolve
  // labels + capacity through `privateWagerModeLabel` / `privateWagerCapacity`,
  // and because this table is still the mirror of the server catalog. Keep the
  // ids byte-identical.
  {
    key: 'cells',
    title: 'Neon Cells',
    modes: [
      { id: 'eclipse:slayer', label: 'ECLIPSE · SLAYER', hint: 'safe zones · kill count', capacity: 8 },
      { id: 'eclipse:lms', label: 'ECLIPSE · LAST MAN STANDING', hint: 'safe zones · last one standing', capacity: 8 },
      { id: 'blitz:slayer', label: 'BLITZ · SLAYER', hint: 'fast collapse · kill count', capacity: 8 },
      { id: 'blitz:lms', label: 'BLITZ · LAST MAN STANDING', hint: 'fast collapse · last one standing', capacity: 8 },
    ],
  },
  {
    key: 'asteroids',
    title: 'Neon Asteroids',
    modes: [
      { id: 'eclipse:slayer', label: 'ECLIPSE · SLAYER', hint: 'safe zones · kill count', capacity: 8 },
      { id: 'eclipse:lms', label: 'ECLIPSE · LAST MAN STANDING', hint: 'safe zones · last one standing', capacity: 8 },
      { id: 'blitz:slayer', label: 'BLITZ · SLAYER', hint: 'fast collapse · kill count', capacity: 8 },
      { id: 'blitz:lms', label: 'BLITZ · LAST MAN STANDING', hint: 'fast collapse · last one standing', capacity: 8 },
    ],
  },
  {
    key: 'golf',
    title: 'Neon Golf Clash',
    modes: [{ id: 'classic', label: 'Clash', hint: 'head to head', capacity: 2 }],
  },
  {
    key: 'clumsy',
    title: 'Neon Clumsy',
    modes: [{ id: 'classic', label: 'Run', hint: 'last mummy standing · up to 6', capacity: 6 }],
  },
  {
    key: 'pugshooter',
    title: 'Neon Pug Shooter',
    modes: [
      { id: 'ffa', label: 'Free For All', hint: 'everyone for themselves', capacity: 6 },
      { id: 'duel', label: '1v1 Duel', hint: 'one on one', capacity: 2 },
      { id: 'duo', label: '2v2 Teams', hint: 'four players, two sides', capacity: 4, minPlayers: 4 },
    ],
  },
];

/** Catalog lookup for one game. */
export function privateWagerGame(gameKey: PrivateGameKey): PrivateWagerGame | undefined {
  return PRIVATE_WAGER_GAMES.find((game) => game.key === gameKey);
}

/** Human title for a game key ("NEON CHESS"), or the raw key if unknown. */
export function privateWagerGameTitle(gameKey: PrivateGameKey): string {
  return privateWagerGame(gameKey)?.title ?? gameKey;
}

/** Human label for a mode ("Best of 3"), or the raw mode if unknown. */
export function privateWagerModeLabel(gameKey: PrivateGameKey, mode: string): string {
  return privateWagerGame(gameKey)?.modes.find((m) => m.id === mode)?.label ?? mode;
}

/**
 * Seats the room offers. Used ONLY to pick the layout before the first
 * `private:room` lands — after that the server's `capacity` is authoritative.
 */
export function privateWagerCapacity(gameKey: PrivateGameKey, mode: string): number {
  return privateWagerGame(gameKey)?.modes.find((m) => m.id === mode)?.capacity ?? 2;
}

/** Players REQUIRED before a private room can start (server minPlayers).
 *  2 everywhere except strict team modes (pugshooter duo = 4). */
export function privateWagerMinPlayers(gameKey: string, modeId: string): number {
  const game = PRIVATE_WAGER_GAMES.find((g) => g.key === gameKey);
  return game?.modes.find((m) => m.id === modeId)?.minPlayers ?? 2;
}

/**
 * Is this a game key the catalog knows? The nav bar and the notification store
 * receive `gameKey` straight off the wire, so they narrow it here rather than
 * casting — an invite for an unknown game is dropped instead of rendering a
 * row that can never be joined.
 */
export function isPrivateGameKey(value: unknown): value is PrivateGameKey {
  return (
    typeof value === 'string' &&
    PRIVATE_WAGER_GAMES.some((game) => game.key === value)
  );
}
