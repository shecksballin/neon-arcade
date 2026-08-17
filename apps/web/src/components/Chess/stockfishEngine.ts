/**
 * STOCKFISH ENGINE (client-side)
 * ==============================
 * Runs Stockfish 18 (lite, single-threaded) inside a Web Worker in the
 * browser — this is where a chess engine belongs for a web app. The old
 * implementation POSTed every position to a server `/api/chess/move`
 * route that spun up a shared `stockfish` npm process keyed by IP; that
 * route was never ported to the new Hono backend (so it 404'd), and even
 * when it existed it raced concurrent games and re-initialised per move.
 *
 * The engine files live in `public/engine/`:
 *   - stockfish-18-lite-single.js   (Emscripten loader, run as the Worker)
 *   - stockfish-18-lite-single.wasm (auto-resolved as the .js sibling)
 *
 * Single-threaded => no SharedArrayBuffer, so NO cross-origin-isolation
 * (COOP/COEP) headers are required. It's ~7MB and superhuman in strength.
 *
 * I/O is standard UCI over the Worker channel: post command strings,
 * receive newline-free protocol lines back (`uciok`, `readyok`,
 * `info ...`, `bestmove e2e4 ...`).
 */

const ENGINE_URL = '/engine/stockfish-18-lite-single.js';
const HANDSHAKE_TIMEOUT_MS = 20_000;

export interface BestMoveOptions {
  /** Stockfish "Skill Level", 0 (weakest) – 20 (full strength). Default 10. */
  skillLevel?: number;
  /** Fixed search depth. When set, overrides `movetime`. */
  depth?: number;
  /** Search time budget in ms. Ignored when `depth` is set. */
  movetime?: number;
}

type Line = string;
type LineListener = (line: Line) => void;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

class StockfishEngine {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private listeners = new Set<LineListener>();
  /** Serialises searches — the engine can only search one position at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  /** Kick off worker creation + UCI handshake early (e.g. on mount) so the
   *  first real move isn't delayed by the ~7MB WASM download/compile. */
  warmup(): void {
    void this.ensureReady().catch(() => {
      /* surfaced by callers of bestMove(); swallow here so warmup is fire-and-forget */
    });
  }

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(ENGINE_URL);
      } catch (err) {
        this.ready = null;
        reject(err);
        return;
      }
      this.worker = worker;

      const fail = (err: unknown) => {
        // Let a later call retry from scratch rather than being stuck with
        // a dead worker + permanently-rejected promise.
        this.teardown();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const handshakeTimer = setTimeout(
        () => fail(new Error('Stockfish handshake timed out')),
        HANDSHAKE_TIMEOUT_MS,
      );

      worker.onerror = (e: ErrorEvent) => {
        clearTimeout(handshakeTimer);
        fail(new Error(`Stockfish worker error: ${e.message || 'failed to load'}`));
      };

      worker.onmessage = (e: MessageEvent) => {
        const line: Line = typeof e.data === 'string' ? e.data : String(e.data);
        // Copy to an array so a listener removing itself mid-iteration is safe.
        for (const l of [...this.listeners]) l(line);
      };

      // UCI handshake: uci -> uciok, then isready -> readyok.
      const onHandshake: LineListener = (line) => {
        if (line === 'uciok') {
          this.send('isready');
        } else if (line === 'readyok') {
          clearTimeout(handshakeTimer);
          this.listeners.delete(onHandshake);
          resolve();
        }
      };
      this.listeners.add(onHandshake);

      this.send('uci');
      this.send('ucinewgame');
    });

    return this.ready;
  }

  private send(cmd: string): void {
    this.worker?.postMessage(cmd);
  }

  /**
   * Best move for a FEN. Resolves to a UCI move string ("e2e4", "e7e8q")
   * or "" when the engine has no legal move (mate/stalemate) or fails.
   * Calls are serialised so overlapping requests can't corrupt the search.
   */
  bestMove(fen: string, opts: BestMoveOptions = {}): Promise<string> {
    const run = () => this.search(fen, opts);
    // Chain onto the queue regardless of whether the previous search
    // resolved or rejected, so one failure can't stall every later move.
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  private async search(fen: string, opts: BestMoveOptions): Promise<string> {
    await this.ensureReady();

    const skill = clamp(Math.round(opts.skillLevel ?? 10), 0, 20);
    const useDepth = typeof opts.depth === 'number' && opts.depth > 0;
    // Skill Level is the primary strength lever (Stockfish injects weaker
    // choices at low skill); a matching time budget keeps weak levels snappy
    // and strong levels deliberate.
    const movetime = opts.movetime ?? clamp(200 + skill * 90, 200, 2000);

    this.send(`setoption name Skill Level value ${skill}`);
    this.send(`position fen ${fen}`);

    return new Promise<string>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;

      const finish = (move: string) => {
        if (done) return;
        done = true;
        this.listeners.delete(onLine);
        clearTimeout(timer);
        resolve(move);
      };

      const onLine: LineListener = (line) => {
        if (!line.startsWith('bestmove')) return;
        const move = line.split(/\s+/)[1] ?? '';
        finish(move === '(none)' ? '' : move);
      };

      // Register the listener BEFORE issuing `go` so an instant reply can't
      // slip past us.
      this.listeners.add(onLine);
      this.send(useDepth ? `go depth ${opts.depth}` : `go movetime ${movetime}`);

      // Safety net: the engine should answer well within the budget. If it
      // doesn't, ask it to `stop` (which still emits a bestmove our listener
      // catches); only resolve empty if even that is silent.
      const budget = (useDepth ? 8_000 : movetime) + 4_000;
      timer = setTimeout(() => {
        this.send('stop');
        setTimeout(() => finish(''), 800);
      }, budget);
    });
  }

  /** Terminate the worker and reset state. Next call re-creates it. */
  private teardown(): void {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        /* ignore */
      }
    }
    this.worker = null;
    this.ready = null;
    this.listeners.clear();
  }

  dispose(): void {
    if (this.worker) {
      try {
        this.send('quit');
      } catch {
        /* ignore */
      }
    }
    this.teardown();
    this.queue = Promise.resolve();
  }
}

/** One warm engine reused across games — idle when not searching. */
export const stockfish = new StockfishEngine();
