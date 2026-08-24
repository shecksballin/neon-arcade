export interface BoardEntry {
  name: string;
  won: boolean;
  score: string;      // e.g. "4–2"
  rounds: number;     // total rounds played (incl. sudden death)
  perfect: number;    // green-timed kicks this match
  saves: number;      // saves made as keeper
  date: number;
}

const KEY = 'neon-kickoff-leaderboard-v1';

export function loadBoard(): BoardEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as BoardEntry[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** ranked: wins first, then saves+perfect strikes as skill tiebreak, newest last */
export function rankBoard(list: BoardEntry[]): BoardEntry[] {
  return [...list].sort(
    (a, b) =>
      Number(b.won) - Number(a.won) ||
      b.saves + b.perfect - (a.saves + a.perfect) ||
      b.date - a.date
  );
}

export function saveMatch(entry: BoardEntry): BoardEntry[] {
  const list = [...loadBoard(), entry].slice(-50); // keep the last 50 matches
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full/blocked — leaderboard just stays in memory */
  }
  return list;
}
