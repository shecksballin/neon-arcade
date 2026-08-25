// src/components/Cells/ArgarGame.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Maximize, Minimize, RefreshCw, Activity, Target, Timer, Zap, Menu, Volume2, VolumeX, Globe } from 'lucide-react';
import { GamePauseMenu } from '../common/GamePauseMenu';
// Shared in-match board (the Pug Shooter HUD card) — replaces the hand-rolled
// top-right leaderboard overlay. Display only: engine.leaderboard stays the
// gameplay source of truth (bots, zone reveal, MiniMap all read it).
import { MatchLeaderboard } from '../common/MatchLeaderboard';
// Level progression overlay + the practice-XP self-report hook. Practice is
// the ONLY mode that self-reports ('cells' practice rounds are XP-only,
// rank:null by construction); online results stay socket-authoritative.
import { PostGameProgression } from '../common/PostGameProgression';
import { usePracticeXp } from '../../hooks/usePracticeXp';
// "Are you sure? leaving forfeits" — every mid-run exit affordance (pause
// menu Quit, results Exit, the App nav bar) funnels through this guard.
import { useGuardedExit } from '../common/exitGuard';
import { toggleAppFullscreen } from '../common/fullscreen';
import { GameEngine, type Entity } from './gameEngine';
import { ResultsScreen } from '../NeonBucks/ResultsScreen';
import { useNeonBucks } from '../../NeonBucksStore';
import {
  FreeplayNet,
  FREE_PLAY_DIFFICULTY,
  type NetFood,
  type FreeplayMode,
  type FreeplaySector,
  type MatchState,
  type MatchResult,
} from '../../lib/freeplayNet';
import SearchingForMatch from '../common/SearchingForMatch';

// ---------------------------------------------------------------------------
// NETWORK-MODE ADAPTER HELPERS (online play — free_play / slayer / lms)
// The server is authoritative; these helpers map interpolated server players
// into the Entity/Food shapes the existing canvas draw code already expects,
// so the render path itself stays untouched.
// ---------------------------------------------------------------------------

/**
 * SPAWN-SIZE PARITY WITH PRACTICE.
 *
 * The owner's "online spawns far too large" bug came from the server's old
 * mass model (spawn radius 30 = 2× practice) being rendered raw. The server
 * world now uses the PRACTICE constants directly — spawn radius 15, world
 * 6000×6000, food radius 8, the same accel/decay curve — so no conversion is
 * needed and the online cell is pixel-identical to a practice cell (the camera
 * zoom is derived from the radius, so it lines up too).
 *
 * This scale exists as the single knob for that parity: it multiplies EVERY
 * server length (x, y, radii, food, world bounds) uniformly. Uniform matters —
 * scaling radii alone would let big blobs eat from outside their drawn circle.
 * Keep it at 1 while the server mirrors practice; only change it (in the same
 * commit as the server constant) if the two ever diverge again.
 */
const PRACTICE_START_RADIUS = 15;
const SERVER_START_RADIUS = 15; // apps/server/src/socket/freeplay/cellsWorld.ts
const NET_WORLD_SCALE = PRACTICE_START_RADIUS / SERVER_START_RADIUS;

/** HUD/React sync rate while online (Hz→ms). The canvas still runs at rAF;
 *  only the DOM overlays throttle, so React re-renders can't fight the loop. */
const NET_HUD_INTERVAL_MS = 100;

/** The 24-point jiggle ring every rendered cell carries (offsets stay 0 online). */
const makeNetCellPoints = () =>
  Array.from({ length: 24 }, (_, i) => ({
    angle: (i / 24) * Math.PI * 2,
    offset: 0,
    velocity: 0,
  }));

/** Stable neon color derived from the opaque server player id. */
const colorForNetId = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${150 + (Math.abs(hash) % 60)}, 100%, 50%)`;
};

/** Build a minimal Entity-shaped render adapter for one remote player. */
const makeNetCellEntity = (id: string): Entity => ({
  id,
  nickname: 'UNKNOWN',
  x: 0,
  y: 0,
  radius: 15,
  mass: 1,
  color: colorForNetId(id),
  cells: [{ x: 0, y: 0, radius: 15, velocityX: 0, velocityY: 0, mergeTimer: 0, points: makeNetCellPoints() }],
  velocityX: 0,
  velocityY: 0,
  score: 0,
  kills: 0,
});

/**
 * SLAYER RESULT — a ranked KILL BOARD, not a verdict.
 *
 * Contract: "SLAYER has NO winner. Everybody scores points for the kills they
 * got." So there is no Victory/Defeat headline, no winner row styling and no
 * money — every player is listed with the kills they scored, ranked, with our
 * own row highlighted. LMS still uses the normal win/lose ResultsScreen.
 */
const SlayerScoreboard: React.FC<{
  result: MatchResult;
  gameMode: string;
  onRematch: () => void;
  onExit: () => void;
}> = ({ result, gameMode, onRematch, onExit }) => {
  const rows = [...result.standings].sort(
    (a, b) => (b.points || b.kills) - (a.points || a.kills) || a.place - b.place
  );
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/90 backdrop-blur-xl px-6"
    >
      <Target className="w-14 h-14 mb-5 text-[#00FFD1] animate-pulse" />
      <h2 className="text-4xl md:text-6xl font-black text-white italic uppercase tracking-tighter mb-2 text-center">
        Match Over
      </h2>
      <p className="text-[#00FFD1]/80 font-mono text-[11px] uppercase tracking-[0.35em] mb-8 text-center">
        No winner — points for kills
      </p>

      <div className="bg-[#040b0b] border border-[#00FFD1]/30 rounded-xl p-6 w-full max-w-md mb-8">
        <div className="flex justify-between items-center border-b border-[#00FFD1]/10 pb-2 mb-3 font-mono text-[10px] uppercase tracking-widest text-[#00FFD1]/60">
          <span>Rank</span>
          <span className="flex-1 px-3">Operator · {gameMode}</span>
          <span>Kills</span>
        </div>
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {rows.length === 0 && (
            <p className="text-white/40 font-mono text-xs uppercase tracking-widest py-4 text-center">
              No scores reported
            </p>
          )}
          {rows.map((s, idx) => (
            <div
              key={s.id || `${s.name}-${idx}`}
              className={`flex items-center justify-between px-3 py-2 rounded-lg font-mono text-xs ${
                s.isYou ? 'bg-[#00FFD1]/10 text-[#00FFD1] border border-[#00FFD1]/30' : 'text-white/60'
              }`}
            >
              <span className="opacity-50 w-6">#{idx + 1}</span>
              <span className="flex-1 px-3 truncate uppercase">{s.name}</span>
              <span className="font-black text-base italic">{s.points || s.kills}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={onRematch}
          className="px-8 py-4 rounded-2xl bg-[#00FFD1] text-[#081616] font-black uppercase italic tracking-tighter hover:scale-105 transition-all flex items-center gap-2"
        >
          <RefreshCw className="w-5 h-5" /> Play Again
        </button>
        <button
          onClick={onExit}
          className="px-8 py-4 rounded-2xl bg-white/5 border border-white/10 text-white/70 font-black uppercase italic tracking-tighter hover:bg-white/10 transition-all"
        >
          Exit
        </button>
      </div>
    </motion.div>
  );
};

const MiniMap = ({ player, zone, safeZone, nextSafeZone, worldSize, difficulty, leaderboard, camera }: any) => {
  const mapSize = 180;
  
  if (!worldSize.width || !worldSize.height) return null;

  // Use uniform scale to ensure circles stay circles
  const scale = mapSize / Math.max(worldSize.width, worldSize.height);

  const toMapX = (x: number) => mapSize / 2 + x * scale;
  const toMapY = (y: number) => mapSize / 2 + y * scale;

  const showSafeZoneOnMap = (difficulty === 10 || difficulty === 11) || ((difficulty === 12 || difficulty === 13) && leaderboard.slice(0, 5).some((e: any) => e.isPlayer));

  // Viewport indicator dimensions
  const viewW = (window.innerWidth / (worldSize.width * (camera.zoom || 1))) * mapSize;
  const viewH = (window.innerHeight / (worldSize.height * (camera.zoom || 1))) * mapSize;

  return (
    <div 
      className={`w-[180px] h-[180px] backdrop-blur-xl rounded-full border-2 border-white/10 overflow-hidden relative shadow-[0_0_30px_rgba(0,0,0,0.5)] ${difficulty !== 1 ? 'bg-red-950/20' : 'bg-black/60'}`}
      style={{ boxShadow: 'inset 0 0 20px rgba(255,255,255,0.05)' }}
    >
      {/* World Boundary - Now the "Red Zone" */}
      <div 
        className={`absolute border border-white/5 pointer-events-none transition-colors duration-500 ${difficulty !== 1 ? 'bg-red-900/40' : 'bg-white/[0.02]'}`}
        style={{
          left: toMapX(-worldSize.width / 2),
          top: toMapY(-worldSize.height / 2),
          width: worldSize.width * scale,
          height: worldSize.height * scale
        }}
      />

      {/* Current Operational Zone */}
      {difficulty !== 1 && showSafeZoneOnMap && (
        <div 
          className="absolute border-2 border-red-500/80 bg-[#081616] rounded-full transition-all duration-300"
          style={{
            left: toMapX(zone.x) - (zone.radius * scale),
            top: toMapY(zone.y) - (zone.radius * scale),
            width: zone.radius * scale * 2,
            height: zone.radius * scale * 2,
          }}
        />
      )}

      {/* Map Border / Grid subtle */}
      <div className="absolute inset-0 opacity-10 pointer-events-none">
        <div className="absolute top-1/2 w-full h-px bg-white" />
        <div className="absolute left-1/2 h-full w-px bg-white" />
      </div>

      {/* Next Safe Zone Target (Eclipse/Last Man Standing) */}
      {nextSafeZone && showSafeZoneOnMap && (
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="absolute border-2 border-[#00FFD1] bg-[#00FFD1]/20 rounded-full shadow-[0_0_10px_rgba(0,255,209,0.3)]"
          style={{
            left: toMapX(nextSafeZone.x) - (nextSafeZone.radius * scale),
            top: toMapY(nextSafeZone.y) - (nextSafeZone.radius * scale),
            width: nextSafeZone.radius * scale * 2,
            height: nextSafeZone.radius * scale * 2,
          }}
        />
      )}

      {/* Viewport Indicator */}
      <div 
        className="absolute border border-white/20 bg-white/5 pointer-events-none transition-all duration-300"
        style={{
          left: toMapX(player.x) - viewW / 2,
          top: toMapY(player.y) - viewH / 2,
          width: viewW,
          height: viewH
        }}
      />

      {/* Player Signature */}
      <div 
        className="absolute w-2.5 h-2.5 bg-[#00FFD1] rounded-full shadow-[0_0_15px_rgba(0,255,209,1)] z-10 border border-white/20"
        style={{
          left: toMapX(player.x) - 1.25,
          top: toMapY(player.y) - 1.25
        }}
      />
    </div>
  );
};

interface ArgarGameProps {
  difficulty?: number;
  isMultiplayer?: boolean;
  /** The ONLINE mode chosen in the lobby. Null = practice/local play. */
  onlineMode?: FreeplayMode | null;
  /** The ONLINE sector chosen in the lobby (eclipse/blitz). Null = practice. */
  onlineSector?: FreeplaySector | null;
  profile: { name: string; avatarUrl: string } | null;
  onExit: () => void;
  wagerAmount?: number;
  wagerMode?: 'free_play' | 'slayer' | 'lms' | null;
  targetKills?: number;
}

const ArgarGame: React.FC<ArgarGameProps> = ({ difficulty: difficultyProp = 3, isMultiplayer = false, onlineMode = null, onlineSector = null, profile, onExit, wagerAmount = 0, wagerMode = null, targetKills }) => {
  // NETWORK MODE: online play in the mode the lobby picked. The old rule
  // (`isMultiplayer && wagerMode === 'free_play'`) silently forced free play
  // for every online session — slayer and lms now reach the server as
  // themselves. Derived ONCE per mount; every online branch keys off this.
  const isNetworkMode = isMultiplayer && onlineMode !== null;
  /** slayer/lms are match-scoped: they queue first. free_play joins now. */
  const isQueuedOnline = isNetworkMode && onlineMode !== 'free_play';

  // ── ONLINE ZONE RULESET ───────────────────────────────────────────────────
  // The server sends the PRACTICE difficulty code it is simulating (10/11
  // Eclipse, 12/13 Blitz, 1 = the no-zone free-play world) in the match-start
  // payload. Rendering off that number is what makes an online Eclipse/Blitz
  // zone look and behave exactly like the practice one — the old
  // `difficulty = 1` hard-code disabled every zone code path online.
  // Null until the server says; the ref is what the rAF loop reads (a state
  // change alone would not reach the already-captured loop closure).
  const [netDifficulty, setNetDifficulty] = useState<number>(FREE_PLAY_DIFFICULTY);
  const netDifficultyRef = useRef<number>(FREE_PLAY_DIFFICULTY);
  // …and we only DRAW a zone once the server has actually sent zone state in
  // a snapshot. Without this a zone difficulty with no zone data would paint
  // a ring the server does not have — a made-up boundary is worse than none.
  const [netHasZone, setNetHasZone] = useState(false);
  const netHasZoneRef = useRef(false);
  const difficulty = isNetworkMode
    ? netHasZone
      ? netDifficulty
      : FREE_PLAY_DIFFICULTY
    : difficultyProp;

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  // Online skips the "INITIALIZE CORE" briefing entirely (the lobby click was
  // the start), so it begins in 'playing' — no one-frame menu flash.
  const [gameState, setGameState] = useState<'menu' | 'countdown' | 'playing' | 'gameOver'>(
    isNetworkMode ? 'playing' : 'menu'
  );
  const [gameResult, setGameResult] = useState<'win' | 'lost' | null>(null);
  const [score, setScore] = useState(0);
  const [kills, setKills] = useState(0);
  const [killNotifications, setKillNotifications] = useState<{ id: string; name: string; x: number; y: number }[]>([]);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [zoneRadius, setZoneRadius] = useState(0);
  const [zoneX, setZoneX] = useState(0);
  const [zoneY, setZoneY] = useState(0);
  const [safeZone, setSafeZone] = useState({ x: 0, y: 0, radius: 0 });
  const [nextSafeZone, setNextSafeZone] = useState<any>(null);
  const [isZoneShrinking, setIsZoneShrinking] = useState(false);
  const [zonePhaseTimer, setZonePhaseTimer] = useState(0);
  const [countdownTimer, setCountdownTimer] = useState<number | null>(null);
  const [outsideTimer, setOutsideTimer] = useState(0);
  const [maxOutsideTime, setMaxOutsideTime] = useState(0);
  const [boostTimer, setBoostTimer] = useState(0);
  const [isBoosting, setIsBoosting] = useState(false);
  const [playerPos, setPlayerPos] = useState({ x: 0, y: 0 });
  const [playerCellCount, setPlayerCellCount] = useState(0);
  const [mergeHoldProgress, setMergeHoldProgress] = useState(0);
  const isSpacePressed = useRef(false);
  const spaceHoldStartTime = useRef<number | null>(null);
  const hasTriggeredMerge = useRef(false);
  const [cameraState, setCameraState] = useState({ x: 0, y: 0, zoom: 1 });
  const [worldSize, setWorldSize] = useState({ width: 0, height: 0 });
  const [enemies, setEnemies] = useState<any[]>([]);

  // ── Network-mode session state (online play) ──────────────────────────────
  const netRef = useRef<FreeplayNet | null>(null);
  const netInputRef = useRef({ dx: 0, dy: 0, boost: false });
  const netEnemyCacheRef = useRef(new Map<string, Entity>()); // id -> render adapter
  const netFoodSrcRef = useRef<NetFood[] | null>(null);       // identity cache: skip re-mapping unchanged food
  const netFoodMappedRef = useRef<{ x: number; y: number; radius: number; color: string }[]>([]);
  const netHudAtRef = useRef(0);                              // last HUD/React sync (ms)
  const [netJoined, setNetJoined] = useState(false);
  // Matchmaking (slayer/lms only) — set optimistically on entry, never
  // waiting for a server ack.
  const [netSearching, setNetSearching] = useState(false);
  const [netQueue, setNetQueue] = useState({ current: 1, needed: 2 });
  // Lobby-match lifecycle (waiting -> running -> ended) for the countdown.
  const [netMatch, setNetMatch] = useState<MatchState | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  // The server's end-of-match scoreboard. SLAYER renders it as a ranked
  // kill board (no winner); LMS keeps the win/lose ResultsScreen.
  const [netResult, setNetResult] = useState<MatchResult | null>(null);
  // SLAYER only: we were killed out of the field but the match is still
  // running, so there is no verdict to show yet — just wait for the board.
  const [netEliminated, setNetEliminated] = useState(false);
  const [respawnInfo, setRespawnInfo] = useState<{ by: string; until: number } | null>(null);
  const [respawnRemaining, setRespawnRemaining] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMuted, setIsMuted] = useState(() => localStorage.getItem('gameMuted') === 'true');

  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    localStorage.setItem('gameMuted', nextMuted ? 'true' : 'false');
    if (typeof window !== 'undefined' && (window as any).Howler) {
      (window as any).Howler.mute(nextMuted);
    }
    window.dispatchEvent(new CustomEvent('volume-change'));
  };

  useEffect(() => {
    const syncMute = () => {
      setIsMuted(localStorage.getItem('gameMuted') === 'true');
    };
    window.addEventListener('volume-change', syncMute);

    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    return () => {
      window.removeEventListener('volume-change', syncMute);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);
  const animationFrameRef = useRef<number | null>(null);
  const lastTimeRef = useRef(performance.now());
  /** Menu-open freeze for PRACTICE (see the loop's early-out). */
  const menuPausedRef = useRef(false);
  
  // Audio context for sound FX
  const audioContext = useRef<AudioContext | null>(null);
  const victoryBuffer = useRef<AudioBuffer | null>(null);
  const resultBuffer = useRef<AudioBuffer | null>(null);
  const killBuffer = useRef<AudioBuffer | null>(null);

  useEffect(() => {
    // Initialize AudioContext
    audioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)();

    const generateKillSound = () => {
      if (!audioContext.current) return null;
      const duration = 0.4;
      const sampleRate = audioContext.current.sampleRate;
      const buffer = audioContext.current.createBuffer(1, sampleRate * duration, sampleRate);
      const data = buffer.getChannelData(0);
      
      for (let i = 0; i < sampleRate * duration; i++) {
        const t = i / sampleRate;
        // Bubble sound: low to high frequency slide with quick decay
        const freq = 120 + Math.sin(t * 10) * 40 + (1 - Math.exp(-20 * t)) * 200;
        const volume = Math.exp(-12 * t) * (1 - Math.exp(-100 * t));
        data[i] = Math.sin(2 * Math.PI * freq * t) * volume * 0.4;
      }
      return buffer;
    };

    const generateFallbackSound = (isVictory: boolean) => {
      if (!audioContext.current) return null;
      const duration = 1.5;
      const sampleRate = audioContext.current.sampleRate;
      const buffer = audioContext.current.createBuffer(1, sampleRate * duration, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < sampleRate * duration; i++) {
        const t = i / sampleRate;
        const freq = isVictory ? (440 + t * 440) : (440 - t * 220); 
        data[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-2 * t) * 0.3;
      }
      return buffer;
    };

    const loadSound = async (url: string) => {
      try {
        const response = await fetch(url.startsWith('/') ? url.slice(1) : url);
        if (!response.ok) throw new Error(`Status: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        if (audioContext.current) {
          return await audioContext.current.decodeAudioData(arrayBuffer);
        }
      } catch (err) {
        console.warn(`Could not fetch sound ${url}, using fallback:`, err);
        return generateFallbackSound(url.includes('winning'));
      }
      return null;
    };

    const initSounds = async () => {
      victoryBuffer.current = await loadSound('winningresultsoundfx.mp3');
      resultBuffer.current = await loadSound('result.mp3');
      killBuffer.current = generateKillSound();
    };

    initSounds();

    return () => {
      if (audioContext.current) {
        audioContext.current.close();
      }
    };
  }, []);

  const playEffect = useCallback((type: 'win' | 'lost' | 'kill') => {
    if (localStorage.getItem('gameMuted') === 'true') return;
    const buffer = type === 'win' ? victoryBuffer.current : (type === 'lost' ? resultBuffer.current : killBuffer.current);
    if (!audioContext.current || !buffer) return;

    if (audioContext.current.state === 'suspended') {
      audioContext.current.resume();
    }

    const source = audioContext.current.createBufferSource();
    const gainNode = audioContext.current.createGain();
    
    source.buffer = buffer;
    gainNode.gain.value = 0.6;
    
    source.connect(gainNode);
    gainNode.connect(audioContext.current.destination);
    
    source.start(0);
  }, []);

  const [sessionWinnings, setSessionWinnings] = useState(0);
  const { win, wager, isFirstPractice } = useNeonBucks();

  // A confirmed mid-run exit ends the round AS A LOSS: the results screen
  // (with a forfeit note), the money effect and the practice XP report all
  // run exactly like a normal death — no second settle path exists.
  const [forfeited, setForfeited] = useState(false);

  // Practice XP — self-reported award, chained as the progression overlay
  // (the same usePracticeXp → PostGameProgression pattern Chess/Trivia use).
  // Online rounds NEVER touch this: freeplay results are settled by the
  // server world, and /api/stats/session only accepts 'cells' as practice.
  const { practiceProgression, armRound, reportRound, clearPracticeProgression } =
    usePracticeXp('cells');

  // "Leaving forfeits" guard. Active ONLY while a round is genuinely live:
  // not on the menu briefing, not on a finished results screen, and NOT
  // while matchmaking — gameState is optimistically 'playing' during the
  // slayer/lms queue, but cancelling a queue is free (the SearchingForMatch
  // Cancel keeps its existing immediate path).
  const { requestExit, finishExit, abortPendingExit, exitPending, confirmDialog } =
    useGuardedExit({
      active: gameState === 'playing' && !netSearching,
      onForfeit: () => {
        if (isNetworkMode) {
          if (onlineMode === 'free_play') {
            // The permanent world scores nothing on the way out — the
            // unmount cleanup emits freeplay:leave. Nothing to show: go now.
            return 'immediate';
          }
          // Slayer/LMS: leave the server match (the world treats that as a
          // forfeit and plays on without us — no netResult will ever arrive
          // after leave()), then show a local loss results screen. The
          // exitPending effect below cues finishExit once that screen is up.
          netRef.current?.leave();
          netRef.current = null;
          setForfeited(true);
          setGameResult('lost');
          setGameState('gameOver');
          if (engineRef.current) engineRef.current.gameState = 'gameOver';
          return 'wait';
        }
        // Practice: force the exact loss path a death takes — engine AND
        // React state together — so the existing money effect scores the
        // round (slayer still pays the kills already banked) and reports
        // the practice XP exactly once. Results + progression play, then
        // finishExit() (from PostGameProgression's onDone) navigates.
        setForfeited(true);
        if (engineRef.current) {
          engineRef.current.gameState = 'gameOver';
          engineRef.current.gameResult = 'lost';
        }
        setGameResult('lost');
        setGameState('gameOver');
        return 'wait';
      },
      copy: () =>
        !isNetworkMode
          ? {
              message:
                wagerAmount > 0
                  ? 'Leaving now ends the practice round as a loss and forfeits your wager. Your results will play before you go.'
                  : 'Leaving now ends the practice round as a loss. Your results will play before you go.',
            }
          : onlineMode === 'free_play'
            ? {
                title: 'Leave the world?',
                message:
                  'Leaving despawns your cell and drops the mass you have grown. Nothing is scored in the free-play world.',
                confirmLabel: 'Leave world',
              }
            : {
                message:
                  'Leaving now abandons the match — it counts as a loss. Your results will play before you go.',
              },
    });

  // Online slayer/lms forfeit: we LEFT the world, so neither a match_end nor
  // any progression payload will ever arrive (freeplay XP settles server-side
  // with no client event today). The results screen is the whole story —
  // once it is up, cue the deferred navigation; the hook still holds it for
  // the minimum dwell and has a 12s fallback regardless.
  useEffect(() => {
    if (exitPending && isNetworkMode && gameState === 'gameOver') finishExit();
  }, [exitPending, isNetworkMode, gameState, finishExit]);

  useEffect(() => {
    if (gameState === 'gameOver' && gameResult) {
       // ONLINE HAS NO MONEY THIS PASS: never call wager()/win() online.
       // (wagerMode is null on the online path, so this block is doubly
       // guarded — the isNetworkMode check documents the intent.)
       if (!isNetworkMode && wagerAmount > 0 && wagerMode) {
          if (wagerMode === 'free_play') {
             if (gameResult === 'win') {
                 // Won free play
                 const payout = (engineRef.current?.player.kills ?? 0) * wagerAmount;
                 win(payout);
                 setSessionWinnings(payout);
             } else {
                 setSessionWinnings(0 - Math.min(wagerAmount, 0)); // Fee was paid in WagerMenu, so sessionWinnings is just 0 but we want to show -wagerAmount
             }
          } else if (wagerMode === 'slayer') {
             // what you kill is what you get, even if you die
             const payout = (engineRef.current?.player.kills ?? 0) * wagerAmount;
             if (payout > 0) win(payout);
             setSessionWinnings(payout - wagerAmount);
          } else if (wagerMode === 'lms') {
             if (gameResult === 'win') {
                const totalBots = 9; // standard practice has 9 enemies
                const pot = (totalBots + 1) * wagerAmount;
                 win(pot);
                 setSessionWinnings(pot - wagerAmount);
             } else {
                 setSessionWinnings(0 - wagerAmount);
             }
          }
       }
       playEffect(gameResult === 'win' ? 'win' : 'lost');

       // Practice XP: the single self-report for the round. usePracticeXp
       // dedupes per armRound(), so a re-fired effect cannot double-report.
       // Online rounds are settled by the server world and must NEVER
       // self-report (the server rejects a non-practice 'cells' row anyway).
       if (!isNetworkMode) {
          reportRound({
             result: gameResult === 'win' ? 'win' : 'loss',
             score: Math.floor(engineRef.current?.player.score ?? 0),
          });
       }
    }
  }, [gameState, gameResult, playEffect, wagerAmount, wagerMode, win, isNetworkMode, reportRound]);

  const addKillNotification = useCallback((kill: { name: string, x: number, y: number }) => {
    const id = Math.random().toString(36).substr(2, 9);
    setKillNotifications(prev => [...prev, { id, ...kill }]);
    playEffect('kill');
    setTimeout(() => {
      setKillNotifications(prev => prev.filter(n => n.id !== id));
    }, 2000);
  }, [playEffect]);

  // Initialize engine
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Use container size or window size
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;

    const engine = new GameEngine(width, height, isMultiplayer, difficulty);
    engineRef.current = engine;

    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [isMultiplayer]);

  // (The online session's start + teardown live in ONE effect further down,
  // next to startNetworkGame — see "ONLINE: enter on mount".)

  // NETWORK MODE: respawn-overlay countdown ticker.
  useEffect(() => {
    if (!respawnInfo) {
      setRespawnRemaining(0);
      return;
    }
    const id = window.setInterval(() => {
      setRespawnRemaining(Math.max(0, (respawnInfo.until - Date.now()) / 1000));
    }, 100);
    return () => window.clearInterval(id);
  }, [respawnInfo]);

  const renderGame = useCallback((ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, engine: GameEngine) => {
    // Helper to safely add alpha to hex or hsl
    const withAlpha = (colorStr: string, alpha: number) => {
      if (colorStr.startsWith('#')) {
        const hexAlpha = Math.round(alpha * 255).toString(16).padStart(2, '0');
        return colorStr.slice(0, 7) + hexAlpha;
      }
      if (colorStr.startsWith('hsl')) {
        const base = colorStr.replace('hsl', 'hsla').replace(')', '');
        return `${base}, ${alpha})`;
      }
      return colorStr;
    };

    // Clear
    ctx.fillStyle = '#081616';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const { camera } = engine;

    // Draw Grid
    const gridSize = 100;
    ctx.strokeStyle = '#00FFD1';
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.05;

    const startX = Math.floor((camera.x - (canvas.width / 2) / camera.zoom) / gridSize) * gridSize;
    const startY = Math.floor((camera.y - (canvas.height / 2) / camera.zoom) / gridSize) * gridSize;
    const endX = startX + (canvas.width / camera.zoom) + gridSize * 2;
    const endY = startY + (canvas.height / camera.zoom) + gridSize * 2;

    for (let x = startX; x <= endX; x += gridSize) {
      const screenX = (x - camera.x) * camera.zoom + canvas.width / 2;
      ctx.beginPath();
      ctx.moveTo(screenX, 0);
      ctx.lineTo(screenX, canvas.height);
      ctx.stroke();
    }
    for (let y = startY; y <= endY; y += gridSize) {
      const screenY = (y - camera.y) * camera.zoom + canvas.height / 2;
      ctx.beginPath();
      ctx.moveTo(0, screenY);
      ctx.lineTo(canvas.width, screenY);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;

    // Draw Food
    engine.food.forEach(food => {
      const sx = (food.x - camera.x) * camera.zoom + canvas.width / 2;
      const sy = (food.y - camera.y) * camera.zoom + canvas.height / 2;
      const sr = food.radius * camera.zoom;
      
      // Only draw if on screen
      if (sx + sr < 0 || sx - sr > canvas.width || sy + sr < 0 || sy - sr > canvas.height) return;

      ctx.fillStyle = food.color;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
    });

    // Draw Particles
    engine.particles.forEach(p => {
      const sx = (p.x - camera.x) * camera.zoom + canvas.width / 2;
      const sy = (p.y - camera.y) * camera.zoom + canvas.height / 2;
      const sr = p.radius * camera.zoom;
      
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.life > 0 ? p.life : 0;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1.0;

    // Draw Zone Boundary
    const zx = (engine.zoneX - camera.x) * camera.zoom + canvas.width / 2;
    const zy = (engine.zoneY - camera.y) * camera.zoom + canvas.height / 2;
    const zr = engine.zoneRadius * camera.zoom;

    // Safe Zone visibility logic
    let showSafeZone = engine.difficulty === 10 || engine.difficulty === 11;
    if (engine.difficulty === 12 || engine.difficulty === 13) {
      const top5 = engine.leaderboard.slice(0, 5);
      if (top5.some(e => e.isPlayer)) showSafeZone = true;
    }

    // Draw the "Dead Zone" (Red outside the safe circle)
    if (engine.difficulty !== 1 && zr > 0 && showSafeZone) {
      ctx.save();
      ctx.beginPath();
      // Cover the entire screen
      ctx.rect(0, 0, canvas.width, canvas.height);
      // Create a hole for the safe zone
      ctx.arc(zx, zy, zr, 0, Math.PI * 2, true);
      ctx.fillStyle = 'rgba(255, 0, 51, 0.15)'; 
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = '#ff0033';
      ctx.lineWidth = 10 * camera.zoom;
      ctx.setLineDash([20 * camera.zoom, 10 * camera.zoom]); 
      ctx.beginPath();
      ctx.arc(zx, zy, zr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]); 

      const zoneGlow = ctx.createRadialGradient(zx, zy, zr - 20 * camera.zoom, zx, zy, zr + 20 * camera.zoom);
      zoneGlow.addColorStop(0, 'rgba(255, 0, 51, 0)');
      zoneGlow.addColorStop(0.5, 'rgba(255, 0, 51, 0.2)');
      zoneGlow.addColorStop(1, 'rgba(255, 0, 51, 0)');
      ctx.fillStyle = zoneGlow;
      ctx.beginPath();
      ctx.arc(zx, zy, zr + 30 * camera.zoom, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw Next Safe Zone (Difficulty 10 & 12)
    if (engine.nextSafeZone && showSafeZone) {
        const nzx = (engine.nextSafeZone.x - camera.x) * camera.zoom + canvas.width / 2;
        const nzy = (engine.nextSafeZone.y - camera.y) * camera.zoom + canvas.height / 2;
        const nzr = engine.nextSafeZone.radius * camera.zoom;

        ctx.strokeStyle = '#00FFD1';
        ctx.lineWidth = 3 * camera.zoom;
        ctx.setLineDash([10 * camera.zoom, 5 * camera.zoom]);
        ctx.beginPath();
        ctx.arc(nzx, nzy, nzr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        
        ctx.fillStyle = 'rgba(0, 255, 209, 0.05)';
        ctx.fill();
        
        ctx.fillStyle = 'rgba(0, 255, 209, 0.5)';
        ctx.font = `bold ${Math.max(8, 12 * camera.zoom)}px font-mono`;
        ctx.textAlign = 'center';
        ctx.fillText('SAFE ZONE TARGET', nzx, nzy - nzr - 10 * camera.zoom);
    }

    // Draw Entities (AI & Player)
    [...engine.enemies, engine.player].forEach(entity => {
      const color = entity.id === 'player' ? '#00FFD1' : entity.color;
      const isEntityBoosting = entity.isBoosting && entity.boostTimer && entity.boostTimer > 0;
      
      entity.cells.forEach(cell => {
        const sx = (cell.x - camera.x) * camera.zoom + canvas.width / 2;
        const sy = (cell.y - camera.y) * camera.zoom + canvas.height / 2;
        const sr = cell.radius * camera.zoom;

        if (sx + sr < -150 || sx - sr > canvas.width + 150 || sy + sr < -150 || sy - sr > canvas.height + 150) return;

        // Massive Glow (Connect Wallet Style)
        let glowMultiplier = 2.5;
        if (isEntityBoosting) {
             glowMultiplier += Math.sin(Date.now() / 250) * 0.3;
        }
        const glowSize = Math.max(sr + 1, sr * glowMultiplier);
        
        const glow = ctx.createRadialGradient(sx, sy, sr * 0.6, sx, sy, glowSize);
        glow.addColorStop(0, withAlpha(color, 0.5));
        glow.addColorStop(0.3, withAlpha(color, 0.15));
        glow.addColorStop(1, withAlpha(color, 0));
        
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(sx, sy, glowSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        // Draw Jiggly Shape
        ctx.beginPath();
        if (cell.points && cell.points.length > 0) {
          cell.points.forEach((p, i) => {
            const r = (cell.radius + p.offset) * camera.zoom;
            const x = sx + Math.cos(p.angle) * r;
            const y = sy + Math.sin(p.angle) * r;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
        } else {
          ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        }
        ctx.closePath();

        // Inner Gradient (Connect Wallet Look)
        const innerGrad = ctx.createLinearGradient(sx - sr, sy - sr, sx + sr, sy + sr);
        innerGrad.addColorStop(0, color);
        innerGrad.addColorStop(1, withAlpha(color, 0.6));
        
        ctx.fillStyle = innerGrad;
        ctx.fill();

        // Sharp Border
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 1.5 * camera.zoom;
        ctx.stroke();
        
        // Inner Glow Border
        ctx.strokeStyle = color;
        ctx.lineWidth = 4 * camera.zoom;
        ctx.globalAlpha = 0.5;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      });

      // Draw Name tag below the main mass of the entity
      const sx = (entity.x - camera.x) * camera.zoom + canvas.width / 2;
      const sy = (entity.y - camera.y) * camera.zoom + canvas.height / 2;
      const sr = entity.radius * camera.zoom;
      const name = entity.id === 'player' ? profile?.name : entity.nickname;

      if (name && sx > -100 && sx < canvas.width + 100 && sy > -100 && sy < canvas.height + 100) {
        ctx.fillStyle = 'white';
        ctx.font = `600 ${Math.max(10, 14 * camera.zoom)}px 'Space Grotesk', sans-serif`;
        ctx.textAlign = 'center';
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.fillText(name.toUpperCase(), sx, sy + sr + 25 * camera.zoom);
        ctx.shadowBlur = 0;
      }
    });
  }, [profile]);

  /**
   * NETWORK MODE frame: pull the interpolated server snapshot, write it into
   * the engine's render fields (thin adapter — the draw code is untouched),
   * publish the current input, and sync the HUD. NO local rules run here, so
   * the empty-world instant-victory check can never fire online.
   */
  const networkFrame = useCallback((engine: GameEngine, time: number) => {
    const net = netRef.current;
    const view = net?.interpolate(time) ?? null;

    // ── Zone ruleset: whatever difficulty code the SERVER reports ──
    // Read every frame (not just on `joined`) so it cannot be lost to event
    // ordering. Never falls back to 1 once known — a torn-down session must
    // not blank the zone the results screen is drawn over.
    const serverDifficulty = net?.matchDifficulty ?? null;
    if (serverDifficulty !== null && serverDifficulty !== netDifficultyRef.current) {
      netDifficultyRef.current = serverDifficulty;
      setNetDifficulty(serverDifficulty);
    }
    // Latch "the server really is sending zone state" (sticky for the session
    // so one zone-less snapshot cannot flicker the ring away).
    if (view?.zone && !netHasZoneRef.current) {
      netHasZoneRef.current = true;
      setNetHasZone(true);
    }
    // The canvas draw code gates every zone visual on engine.difficulty.
    engine.difficulty = netHasZoneRef.current ? netDifficultyRef.current : FREE_PLAY_DIFFICULTY;

    if (view) {
      // Own cell: the pose comes from FreeplayNet's LOCAL PREDICTION (smooth,
      // input-latency-free, reconciled against the server every frame) — that
      // is what killed the constant jitter. Radius is scaled to practice units.
      if (view.you) {
        const you = view.you;
        const r = Number(you.r ?? you.radius ?? SERVER_START_RADIUS) * NET_WORLD_SCALE;
        const x = you.x * NET_WORLD_SCALE;
        const y = you.y * NET_WORLD_SCALE;
        engine.player.x = x;
        engine.player.y = y;
        engine.player.radius = r;
        engine.player.kills = Number(you.kills ?? engine.player.kills ?? 0);
        const cell0 = engine.player.cells[0];
        if (cell0) {
          cell0.x = x;
          cell0.y = y;
          cell0.radius = r;
        }
        engine.player.score = Number(you.mass ?? you.score ?? r);
      }
      // Boost: the server owns the banked seconds (5 per kill, practice rule);
      // the local key state drives the glow instantly so it feels responsive.
      const boostLeft = Number(view.you?.boostRemaining ?? 0);
      engine.player.isBoosting = netInputRef.current.boost && boostLeft > 0;
      engine.player.boostTimer = boostLeft;

      // Remote players -> cached Entity-shaped adapters for the existing draw code.
      const cache = netEnemyCacheRef.current;
      const seen = new Set<string>();
      engine.enemies = view.players.map((pl) => {
        seen.add(pl.id);
        let ent = cache.get(pl.id);
        if (!ent) {
          ent = makeNetCellEntity(pl.id);
          cache.set(pl.id, ent);
        }
        const r = Number(pl.r ?? pl.radius ?? SERVER_START_RADIUS) * NET_WORLD_SCALE;
        const x = pl.x * NET_WORLD_SCALE;
        const y = pl.y * NET_WORLD_SCALE;
        ent.x = x;
        ent.y = y;
        ent.radius = r;
        ent.nickname = pl.name ?? 'UNKNOWN';
        ent.score = Number(pl.mass ?? pl.score ?? 0);
        ent.isBoosting = !!pl.boosting;
        ent.boostTimer = pl.boosting ? 1 : 0;
        const c = ent.cells[0];
        c.x = x;
        c.y = y;
        c.radius = r;
        return ent;
      });
      // Prune adapters for players that left our view.
      for (const id of Array.from(cache.keys())) {
        if (!seen.has(id)) cache.delete(id);
      }

      // ── SERVER-AUTHORITATIVE SAFE ZONE → the engine's render fields ──
      // A mirror, NOT a simulation: the shrink, the phase timers and the
      // next-zone target all come from the snapshot, so what we draw is
      // exactly the ring the server kills you against. (Practice keeps
      // running its own zone in engine.update(); that path is untouched and
      // never executes online.)
      const zone = view.zone;
      if (zone) {
        engine.zoneX = zone.x * NET_WORLD_SCALE;
        engine.zoneY = zone.y * NET_WORLD_SCALE;
        engine.zoneRadius = zone.radius * NET_WORLD_SCALE;
        engine.safeZone = { x: engine.zoneX, y: engine.zoneY, radius: engine.zoneRadius };
        engine.nextSafeZone = zone.next
          ? {
              x: zone.next.x * NET_WORLD_SCALE,
              y: zone.next.y * NET_WORLD_SCALE,
              radius: zone.next.radius * NET_WORLD_SCALE,
            }
          : null;
        engine.isZoneShrinking = zone.shrinking;
        engine.zonePhase = zone.phase;
        engine.zonePhaseTimer = zone.phaseTimer;
        engine.countdownTimer = zone.countdown;
        engine.outsideTimer = zone.outsideTimer;
        engine.maxOutsideTime = zone.maxOutsideTime;
      }

      // Food: re-map only when the delta-accumulated array actually changed.
      if (view.food !== netFoodSrcRef.current) {
        netFoodSrcRef.current = view.food;
        netFoodMappedRef.current = view.food.map((f) => ({
          x: f.x * NET_WORLD_SCALE,
          y: f.y * NET_WORLD_SCALE,
          radius: (f.radius ?? 8) * NET_WORLD_SCALE,
          color: f.color ?? '#00E0B7',
        }));
      }
      engine.food = netFoodMappedRef.current;
    }

    // Publish input: direction from the CELL to the cursor, in WORLD space —
    // exactly how practice samples it. The old screen-centre version assumed
    // the cell sits at the centre, but the camera LAGS the cell (lerp 0.1),
    // so any parked cursor >12px from centre became a perpetual full-speed
    // move command and the cell "drove itself". Sent at 20Hz by the
    // FreeplayNet interval; we just keep the latest values fresh.
    const worldMx = (engine.mouseX - engine.width / 2) / engine.camera.zoom + engine.camera.x;
    const worldMy = (engine.mouseY - engine.height / 2) / engine.camera.zoom + engine.camera.y;
    const cdx = worldMx - engine.player.x;
    const cdy = worldMy - engine.player.y;
    const clen = Math.hypot(cdx, cdy);
    const STOP_DIST = 5 * NET_WORLD_SCALE; // cell rests when the cursor sits on it
    netInputRef.current.dx = clen > STOP_DIST ? cdx / clen : 0;
    netInputRef.current.dy = clen > STOP_DIST ? cdy / clen : 0;
    net?.setInput({ ...netInputRef.current });

    // Camera runs every frame (it is canvas-only, no React involved).
    engine.updateCamera();

    // HUD/React sync is THROTTLED to ~10Hz. The old code pushed ~6 setStates
    // per frame, so React re-rendered on every animation frame and fought the
    // render loop — part of the "jitters constantly" report. AsteroidsCore
    // already used this pattern; Cells now matches it.
    if (time - netHudAtRef.current >= NET_HUD_INTERVAL_MS) {
      netHudAtRef.current = time;
      setScore(Math.floor(engine.player.score));
      setKills(engine.player.kills || 0);
      setPlayerCellCount(1);
      setPlayerPos({ x: engine.player.x, y: engine.player.y });
      setCameraState({ x: engine.camera.x, y: engine.camera.y, zoom: engine.camera.zoom });
      setWorldSize({ width: engine.worldWidth, height: engine.worldHeight });
      setIsBoosting(!!engine.player.isBoosting);
      setBoostTimer(engine.player.boostTimer || 0);
      if (view) {
        // Leaderboard: kills/score online — there is no pot any more.
        const lb = view.leaderboard.map((l) => ({
          name: l.name,
          score: l.score,
          color: '#00FFD1',
          isPlayer: !!profile?.name && l.name === profile.name,
        }));
        setLeaderboard(lb);
        // The canvas gates Blitz's safe-zone reveal on "am I in the top 5?",
        // which it reads from engine.leaderboard — online that table is only
        // populated here, so keep them in step.
        engine.leaderboard = lb;

        // Zone HUD (ring timers, minimap, out-of-zone warning) — same React
        // state the practice HUD renders, fed from the server's zone.
        const zone = view.zone;
        if (zone) {
          setZoneX(engine.zoneX);
          setZoneY(engine.zoneY);
          setZoneRadius(engine.zoneRadius);
          setSafeZone(engine.safeZone);
          setNextSafeZone(engine.nextSafeZone);
          setIsZoneShrinking(engine.isZoneShrinking);
          setZonePhaseTimer(engine.zonePhaseTimer);
          setCountdownTimer(engine.countdownTimer);
          // PRACTICE SEMANTICS: `outsideTimer` is the grace you have LEFT and
          // sits at maxOutsideTime while you are safely inside — the warning
          // overlay is exactly `outsideTimer < maxOutsideTime`. Deriving the
          // "am I outside?" test from the server's own ring and the server's
          // own position keeps that identical online (and keeps the overlay
          // silent for Eclipse/Blitz, whose grace is 0 = instant kill).
          const outside =
            Math.hypot(engine.player.x - engine.zoneX, engine.player.y - engine.zoneY) > engine.zoneRadius;
          const graceLeft = outside
            ? Math.max(0, zone.maxOutsideTime - zone.outsideTimer)
            : zone.maxOutsideTime;
          engine.outsideTimer = graceLeft;
          setOutsideTimer(graceLeft);
          setMaxOutsideTime(zone.maxOutsideTime);
        }
      }
    }
  }, [profile]);

  const gameLoop = useCallback((time: number) => {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;

    const dt = time - lastTimeRef.current;
    lastTimeRef.current = time;

    // Menu open in PRACTICE = frozen sim (network play never pauses).
    if (menuPausedRef.current && !isNetworkMode) {
      const pausedCtx = canvas.getContext('2d');
      if (pausedCtx) renderGame(pausedCtx, canvas, engine);
      animationFrameRef.current = requestAnimationFrame(gameLoop);
      return;
    }

    if (isNetworkMode) {
      // ── NETWORK MODE: no local simulation, no bots, no local win checks ──
      networkFrame(engine, time);
      const netCtx = canvas.getContext('2d');
      if (netCtx) renderGame(netCtx, canvas, engine);
      animationFrameRef.current = requestAnimationFrame(gameLoop);
      return;
    }

    engine.update(dt);
    
    // Handle Space Hold for Merging
    if (isSpacePressed.current && engine.player.cells.length > 1 && !hasTriggeredMerge.current) {
      if (spaceHoldStartTime.current === null) {
        spaceHoldStartTime.current = time;
      }
      const holdDuration = time - spaceHoldStartTime.current;
      
      // Only show loader if we've held for a bit (avoid flicker on tap)
      if (holdDuration > 150) {
        const progress = Math.min((holdDuration - 150) / 850, 1);
        setMergeHoldProgress(progress);
        
        if (progress >= 1) {
          engine.merge();
          hasTriggeredMerge.current = true;
          setMergeHoldProgress(0);
        }
      } else {
        setMergeHoldProgress(0);
      }
    } else {
      setMergeHoldProgress(0);
    }
    
    // Sync state to React occasionally
    if (engine.killNotifications.length > 0) {
      const killsToAdd = [...engine.killNotifications];
      engine.killNotifications = [];
      killsToAdd.forEach(k => addKillNotification(k));
    }

    // These local win conditions are PRACTICE ONLY. Online they must never
    // fire: an empty enemy list (no bots online / still queued) would declare
    // an instant, unearned victory. Server events end online sessions.
    // (Unreachable online anyway — the network branch returns above — but the
    // guard keeps it that way if the loop is ever restructured.)
    if (!isNetworkMode && wagerMode === 'free_play' && targetKills !== undefined && engine.player.kills >= targetKills && engine.gameState !== 'gameOver') {
       engine.gameState = 'gameOver';
       engine.gameResult = 'win';
    } else if (!isNetworkMode && (wagerMode === 'slayer' || wagerMode === 'lms') && engine.enemies.length === 0 && engine.gameState !== 'gameOver') {
       // Only one man standing -> Player!
       engine.gameState = 'gameOver';
       engine.gameResult = 'win';
    }
    
    setScore(Math.floor(engine.player.score));
    setKills(engine.player.kills || 0);
    setPlayerCellCount(engine.player.cells.length);
    setLeaderboard(engine.leaderboard);
    setZoneRadius(engine.zoneRadius);
    setZoneX(engine.zoneX);
    setZoneY(engine.zoneY);
    setSafeZone(engine.safeZone);
    setNextSafeZone(engine.nextSafeZone);
    setIsZoneShrinking(engine.isZoneShrinking);
    setZonePhaseTimer(engine.zonePhaseTimer);
    setCountdownTimer(engine.countdownTimer);
    setOutsideTimer(engine.outsideTimer);
    setMaxOutsideTime(engine.maxOutsideTime);
    setBoostTimer(engine.player.boostTimer || 0);
    setIsBoosting(engine.player.isBoosting || false);
    setPlayerPos({ x: engine.player.x, y: engine.player.y });
    setCameraState({ x: engine.camera.x, y: engine.camera.y, zoom: engine.camera.zoom });
    setWorldSize({ width: engine.worldWidth, height: engine.worldHeight });
    setEnemies(engine.enemies.map(e => ({ x: e.x, y: e.y, color: e.color, id: e.id })));
    setGameState(engine.gameState);
    setGameResult(engine.gameResult);

    const ctx = canvas.getContext('2d');
    if (ctx) renderGame(ctx, canvas, engine);

    animationFrameRef.current = requestAnimationFrame(gameLoop);
  }, [renderGame, networkFrame, isNetworkMode, wagerMode, targetKills, addKillNotification]);

  useEffect(() => {
    if (gameState === 'playing') {
      animationFrameRef.current = requestAnimationFrame(gameLoop);
    } else if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    // WITHOUT THIS the loop outlives the component. gameLoop re-arms itself on
    // every frame, so exiting mid-match left a full simulation + canvas render
    // running for the rest of the session, firing setState into an unmounted
    // tree. The `else if` above only fires on a gameState CHANGE — unmount is
    // not a state change, so it never ran.
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [gameState, gameLoop]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!engineRef.current || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    engineRef.current.setMousePos(e.clientX - rect.left, e.clientY - rect.top);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (e.repeat || isSpacePressed.current) return;
      isSpacePressed.current = true;
      hasTriggeredMerge.current = false;
      spaceHoldStartTime.current = performance.now();
    }
    if (e.code === 'ShiftLeft') {
      e.preventDefault();
      netInputRef.current.boost = true; // network mode: sent with the 20Hz input
      if (engineRef.current) engineRef.current.player.isBoosting = true;
    }
  };

  const handleKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      e.preventDefault();
      
      const now = performance.now();
      const holdDuration = spaceHoldStartTime.current ? now - spaceHoldStartTime.current : 0;
      
      // If short press (tap) AND we haven't already merged this press, split
      // (multiplayer v1 has no split/merge — single circle per player).
      if (holdDuration < 200 && !hasTriggeredMerge.current && spaceHoldStartTime.current !== null && !isNetworkMode) {
        engineRef.current?.split();
      }
      
      isSpacePressed.current = false;
      spaceHoldStartTime.current = null;
      hasTriggeredMerge.current = false;
      setMergeHoldProgress(0);
    }
    if (e.code === 'ShiftLeft') {
      e.preventDefault();
      netInputRef.current.boost = false;
      if (engineRef.current) engineRef.current.player.isBoosting = false;
    }
  };

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  /**
   * ONLINE: enter the world for the mode the lobby picked.
   *   free_play        → joins the permanent world immediately (no queue UI)
   *   slayer / lms    → enters matchmaking; the SEARCHING FOR ONLINE MATCH
   *                       overlay shows until the server starts the match
   * NOTHING here touches NeonBucks — online has no stake and no pot.
   */
  const startNetworkGame = () => {
    if (!onlineMode) return;
    setNetError(null);
    setNetJoined(false);
    setKills(0);
    setScore(0);
    setRespawnInfo(null);
    setSessionWinnings(0);
    setLeaderboard([]);
    netEnemyCacheRef.current.clear();
    netFoodSrcRef.current = null;
    netFoodMappedRef.current = [];
    netHudAtRef.current = 0;
    setNetResult(null);
    setNetEliminated(false);
    // A fresh session knows no ruleset until the server stamps one.
    netDifficultyRef.current = FREE_PLAY_DIFFICULTY;
    setNetDifficulty(FREE_PLAY_DIFFICULTY);
    netHasZoneRef.current = false;
    setNetHasZone(false);
    setNextSafeZone(null);
    setCountdownTimer(null);
    setOutsideTimer(0);
    setMaxOutsideTime(0);

    // OPTIMISTIC searching state — set on entry, NOT on a server ack. A
    // dropped/absent ack can no longer freeze the UI on the lobby.
    const queued = onlineMode !== 'free_play';
    setNetSearching(queued);
    setNetQueue({ current: 1, needed: 2 });
    setNetMatch(null);

    netRef.current?.dispose(); // safety: never stack two sessions
    // The SECTOR is half of the server's difficulty code (eclipse→10/11,
    // blitz→12/13), so it has to travel with the queue request.
    const net = new FreeplayNet('cells', onlineMode, onlineSector);
    netRef.current = net;
    net.join({
      onQueue: ({ current, needed }) => setNetQueue({ current, needed }),
      onJoined: (info) => {
        // The server's world size wins over the canvas-derived local guess
        // (in the same scaled units as every other server length).
        const engine = engineRef.current;
        if (engine) {
          engine.worldWidth = info.world.w * NET_WORLD_SCALE;
          engine.worldHeight = info.world.h * NET_WORLD_SCALE;
        }
        // The zone ruleset the server is actually simulating.
        if (typeof info.difficulty === 'number') {
          netDifficultyRef.current = info.difficulty;
          setNetDifficulty(info.difficulty);
          if (engine) engine.difficulty = info.difficulty;
        }
        setNetSearching(false);
        setNetJoined(true);
      },
      onKill: ({ victimName }) => {
        // No coords in the payload — anchor the notification on our own cell.
        const engine = engineRef.current;
        addKillNotification({ name: victimName, x: engine?.player.x ?? 0, y: engine?.player.y ?? 0 });
      },
      onKilled: ({ by, respawnIn }) => {
        // Free play respawns you; the countdown overlay covers the wait.
        setRespawnInfo({ by, until: Date.now() + respawnIn });
      },
      onRespawn: () => setRespawnInfo(null),
      onMatchState: (state) => setNetMatch(state),
      onEliminated: () => {
        // SLAYER has no loser: being killed does not end YOUR match with a
        // defeat screen, it just takes you out of the field until the server
        // publishes the kill board. Stay connected and show the waiting
        // overlay instead of a verdict.
        if (onlineMode === 'slayer') {
          setNetEliminated(true);
          return;
        }
        // LMS: you are out — the existing win/lose screen is correct. Stay
        // connected so freeplay:match_end can still deliver the standings.
        // Free play: the server despawned us, so drop the session now.
        setGameResult('lost');
        setGameState('gameOver');
        if (engineRef.current) engineRef.current.gameState = 'gameOver';
        if (!queued) {
          netRef.current?.dispose(); // already settled server-side — no leave emit
          netRef.current = null;
        }
      },
      onMatchEnd: (result) => {
        // SLAYER: no winner — the kill-count scoreboard replaces the verdict.
        // LMS: unchanged victory/defeat.
        setNetResult(result);
        // Slayer has neither a win nor a loss, so it gets NO verdict (and no
        // victory/defeat sting) — just the board.
        setGameResult(result.scoring === 'kills' ? null : result.won ? 'win' : 'lost');
        setGameState('gameOver');
        if (engineRef.current) engineRef.current.gameState = 'gameOver';
        netRef.current?.dispose(); // the match is settled server-side
        netRef.current = null;
      },
      onError: ({ code, message }) => {
        setNetError(message ?? code);
        setNetSearching(false);
        setGameState('menu');
        if (engineRef.current) engineRef.current.gameState = 'menu';
        netRef.current?.dispose();
        netRef.current = null;
      },
    });

    if (engineRef.current) engineRef.current.gameState = 'playing';
    setGameState('playing');
    setGameResult(null);
  };

  const startGame = () => {
    if (isNetworkMode) {
      startNetworkGame();
      return;
    }
    if (engineRef.current) {
      armRound(); // the first practice round of this mount starts HERE
      engineRef.current.gameState = 'playing';
      setGameState('playing');
    }
  };

  /**
   * ONLINE: enter on mount, leave on unmount.
   *
   * No "INITIALIZE CORE" gate online — picking a mode in the lobby IS the
   * click, so we go straight to matchmaking (slayer/lms) or the world
   * (free play). Start and teardown share ONE effect on purpose: React 18
   * StrictMode mounts, unmounts and re-mounts in dev, and a separate
   * "start once" guard would leave the second mount with no session.
   *
   * Teardown emits freeplay:leave (in a world) or freeplay:cancel (while
   * queued), so a queue slot can never leak when the view changes.
   *
   * Declared AFTER the engine-init effect so the engine exists when it runs.
   */
  useEffect(() => {
    if (!isNetworkMode) return;
    startNetworkGame();
    return () => {
      netRef.current?.leave();
      netRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNetworkMode]);

  const resetGame = () => {
    // Rematch while a forfeit-exit is pending = "I changed my mind" — drop
    // the deferred navigation instead of yanking the fresh round away.
    abortPendingExit();
    setForfeited(false);
    if (isNetworkMode) {
      startNetworkGame();
      return;
    }
    // New practice round: re-arm the once-per-round XP guard and drop any
    // still-queued progression overlay.
    armRound();
    clearPracticeProgression();
    engineRef.current?.reset();
    engineRef.current!.gameState = 'playing';
    setGameState('playing');
    setGameResult(null);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const [cashoutHoldProgress, setCashoutHoldProgress] = useState(0);
  const [isCashingOut, setIsCashingOut] = useState(false);
  const cashoutStartTime = useRef<number | null>(null);

  useEffect(() => {
     const handleResize = () => {
       if (!canvasRef.current || !engineRef.current) return;
       canvasRef.current.width = window.innerWidth;
       canvasRef.current.height = window.innerHeight;
       engineRef.current.width = window.innerWidth;
       engineRef.current.height = window.innerHeight;
     };
     window.addEventListener('resize', handleResize);
     return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Cash-out is a PRACTICE Neon Bucks feature. Online has no pot to cash out,
  // so the button is not rendered there at all (wagerMode is null online).
  const canCashout = kills > 0;

  /** ONLINE labels: sector comes from the server's difficulty code when it has
   *  landed, otherwise from what the lobby asked for. */
  const netSectorLabel =
    netDifficulty === 12 || netDifficulty === 13
      ? 'Blitz'
      : netDifficulty === 10 || netDifficulty === 11
        ? 'Eclipse'
        : onlineSector === 'blitz'
          ? 'Blitz'
          : onlineSector === 'eclipse'
            ? 'Eclipse'
            : null;
  const netModeLabel = onlineMode === 'lms' ? 'Last Man Standing' : onlineMode === 'slayer' ? 'Slayer' : 'Free Play';
  const onlineLabel =
    onlineMode === 'free_play' || !netSectorLabel ? netModeLabel : `${netSectorLabel} · ${netModeLabel}`;

  const handleCashoutDown = () => {
     if (gameState === 'playing' && !isNetworkMode && canCashout && wagerMode === 'free_play') {
        setIsCashingOut(true);
        cashoutStartTime.current = performance.now();
     }
  };

  const handleCashoutUp = () => {
     setIsCashingOut(false);
     setCashoutHoldProgress(0);
     cashoutStartTime.current = null;
  };

  useEffect(() => {
     let af: number;
     const tickCashout = () => {
        if (isCashingOut && cashoutStartTime.current && gameState === 'playing') {
           const duration = Math.max(0, performance.now() - cashoutStartTime.current);
           const p = duration / 3000;
           setCashoutHoldProgress(Math.min(p, 1));
           if (p >= 1 && engineRef.current) {
               setIsCashingOut(false);
               engineRef.current.gameState = 'gameOver';
               engineRef.current.gameResult = 'win';
               setGameState('gameOver');
               setGameResult('win'); // For instantaneous UI response
           } else {
               af = requestAnimationFrame(tickCashout);
           }
        }
     };
     if (isCashingOut) {
        af = requestAnimationFrame(tickCashout);
     }
     return () => cancelAnimationFrame(af);
  }, [isCashingOut, gameState]);

  return (
    <div 
      ref={containerRef}
      className="fixed inset-0 z-50 bg-[#081616] overflow-hidden"
      onMouseMove={handleMouseMove}
      onMouseUp={handleCashoutUp}
      onMouseLeave={handleCashoutUp}
    >
      <canvas 
        ref={canvasRef}
        className="w-full h-full cursor-none"
      />

      {/* Zone Status Overlay */}
      {gameState === 'playing' && difficulty !== 1 && outsideTimer < maxOutsideTime && (
        <motion.div 
            initial={{ opacity: 0, scale: 1.1 }}
            animate={{ opacity: 1, scale: 1 }}
            className="absolute inset-0 pointer-events-none z-[70] flex items-center justify-center pb-24"
        >
          {/* Red Vignette */}
          <div className="absolute inset-0 bg-radial-[circle_at_center,_transparent_40%,_rgba(255,0,0,0.4)_100%] shadow-[inset_0_0_100px_rgba(255,0,0,0.5)] animate-pulse" />
          
          <div className="text-center space-y-2">
            <p className="text-red-500 font-mono text-xl font-bold tracking-[0.5em] animate-bounce uppercase text-shadow-glow">Warning: Leaving Operational Area</p>
            <div className="bg-red-500/20 backdrop-blur-md border border-red-500/50 px-8 py-4 rounded-2xl">
                <p className="text-white/60 font-mono text-xs uppercase tracking-widest mb-1">Biological Integrity Falling</p>
                <p className="text-6xl font-black text-white italic">{outsideTimer.toFixed(1)}s</p>
            </div>
          </div>
        </motion.div>
      )}

      {/* Blitz Countdown Overlay */}
      {countdownTimer !== null && (
        <div className="absolute inset-0 flex items-center justify-center z-[80] pointer-events-none">
          <motion.div 
            initial={{ scale: 2, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            key={Math.floor(countdownTimer)}
            className="text-[12rem] font-black text-red-500 italic drop-shadow-[0_0_30px_rgba(255,0,0,0.8)]"
          >
            {Math.ceil(countdownTimer)}
          </motion.div>
        </div>
      )}

      {/* Top Center HUD: Timer */}
      {gameState === 'playing' && difficulty !== 1 && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 pointer-events-none z-[60]">
          <div className="backdrop-blur-xl bg-black/60 border border-white/10 px-8 py-4 rounded-3xl flex items-center gap-6 shadow-2xl">
            <div className={`p-2 rounded-xl flex items-center justify-center transition-colors ${isZoneShrinking ? 'bg-red-500/20 text-red-500 animate-pulse' : 'bg-[#00FFD1]/20 text-[#00FFD1]'}`}>
              {isZoneShrinking ? <div className="w-3 h-3 bg-red-500 rounded-full animate-ping" /> : <Timer className="w-6 h-6" />}
            </div>
            
            <div className="text-center min-w-[120px]">
              <p className="text-[10px] font-mono text-white/40 uppercase tracking-[0.2em]">
                {isZoneShrinking ? 'Zone Shrinking' : 'Zone Stable'}
              </p>
              <p className={`text-4xl font-black italic tracking-tighter ${isZoneShrinking ? 'text-red-500' : 'text-white'}`}>
                {Math.ceil(zonePhaseTimer)}s
              </p>
            </div>

            <div className="h-8 w-px bg-white/10" />

            <div className="text-center">
              <p className="text-[10px] font-mono text-white/40 uppercase tracking-[0.2em]">Phase</p>
              <p className="text-2xl font-black text-[#00FFD1] italic">{engineRef.current?.zonePhase}</p>
            </div>
          </div>
        </div>
      )}

      {/* HUD: Bottom Left - Mini Map */}
      {gameState === 'playing' && (
        <div className="absolute bottom-8 left-8 pointer-events-none">
          <MiniMap 
            player={playerPos}
            zone={{ x: zoneX, y: zoneY, radius: zoneRadius }}
            safeZone={safeZone}
            nextSafeZone={nextSafeZone}
            worldSize={worldSize}
            difficulty={difficulty}
            leaderboard={leaderboard}
            camera={cameraState}
          />
        </div>
      )}

      {/* HUD: Top Left */}
      <div className="absolute top-8 left-8 space-y-4 pointer-events-none z-[60]">
        <div className="backdrop-blur-md bg-black/40 border border-[#00FFD1]/20 p-4 rounded-2xl flex items-center gap-4">
          <div className="w-12 h-12 rounded-full border-2 border-[#00FFD1] bg-[#00FFD1]/10 flex items-center justify-center overflow-hidden">
            <img src={profile?.avatarUrl} alt="Me" className="w-full h-full object-cover" />
          </div>
          <div>
            <p className="text-xs font-mono text-[#00FFD1]/60 uppercase tracking-widest">Operator</p>
            <p className="text-xl font-black text-white italic uppercase tracking-tighter">{profile?.name}</p>
          </div>
        </div>

        <div className="flex gap-2">
          <div className="backdrop-blur-md bg-black/40 border border-[#00FFD1]/20 px-6 py-3 rounded-xl flex items-center gap-3">
             <Activity className="w-4 h-4 text-[#00FFD1]" />
             <div className="text-left">
                <p className="text-[10px] font-mono text-white/40 uppercase">Mass Units</p>
                <p className="text-lg font-black text-[#00FFD1] italic tracking-tighter leading-none mt-1">{score}</p>
             </div>
          </div>
          <div className="backdrop-blur-md bg-black/40 border border-red-500/20 px-6 py-3 rounded-xl flex items-center gap-3">
             <Target className="w-4 h-4 text-red-500" />
             <div className="text-left">
                <p className="text-[10px] font-mono text-white/40 uppercase">Kills</p>
                <p className="text-lg font-black text-red-500 italic tracking-tighter leading-none mt-1 uppercase">{kills}</p>
             </div>
          </div>
          {/* Online: mode badge where the SOL pot used to be — no money HUD. */}
          {isNetworkMode && (
            <div className="backdrop-blur-md bg-black/40 border border-[#00FFD1]/20 px-6 py-3 rounded-xl flex items-center gap-3">
               <Globe className="w-4 h-4 text-[#00FFD1]" />
               <div className="text-left">
                  <p className="text-[10px] font-mono text-white/40 uppercase">Online</p>
                  <p className="text-lg font-black text-[#00FFD1] italic tracking-tighter leading-none mt-1 uppercase">
                    {onlineLabel}
                  </p>
               </div>
            </div>
          )}
          {boostTimer > 0 && (
            <motion.div 
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className={`backdrop-blur-md bg-black/40 border ${isBoosting ? 'border-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.3)]' : 'border-[#00FFD1]/20'} px-6 py-3 rounded-xl flex items-center gap-3 transition-colors`}
            >
               <Zap className={`w-4 h-4 ${isBoosting ? 'text-yellow-500 animate-pulse' : 'text-[#00FFD1]'}`} />
               <div className="text-left">
                  <p className="text-[10px] font-mono text-white/40 uppercase">Speed Boost</p>
                  <p className={`text-lg font-black italic tracking-tighter leading-none mt-1 ${isBoosting ? 'text-yellow-500' : 'text-[#00FFD1]'}`}>
                    {boostTimer.toFixed(1)}s
                  </p>
               </div>
            </motion.div>
          )}
        </div>
      </div>

      {/* HUD: Top Right — the shared match leaderboard (pug HUD board).
          DISPLAY ONLY: engine.leaderboard stays the gameplay table (bot AI,
          the canvas Blitz zone reveal and the MiniMap all read its top-5),
          and online code still writes the server board back into it. Mass
          is the score column both online and in practice; each row's cell
          color rides along as the dot. */}
      <MatchLeaderboard
        rows={leaderboard.map((entry) => ({
          name: entry.name,
          value: Math.floor(Number(entry.score ?? 0)),
          isPlayer: !!entry.isPlayer,
          color: entry.color,
        }))}
        valueLabel="MASS"
        max={10}
      />

      {/* Merge Hold Loader */}
      <AnimatePresence>
        {mergeHoldProgress > 0 && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-32 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none z-50"
          >
            <div className="w-48 h-1.5 bg-white/10 rounded-full overflow-hidden border border-white/10 backdrop-blur-md">
              <motion.div 
                className="h-full bg-[#00FFD1] shadow-[0_0_15px_rgba(0,255,209,0.5)]"
                initial={{ width: 0 }}
                animate={{ width: `${mergeHoldProgress * 100}%` }}
                transition={{ type: 'spring', damping: 20, stiffness: 100 }}
              />
            </div>
            <span className="text-[10px] font-black font-mono text-[#00FFD1] tracking-[0.4em] uppercase">
              merge
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Kill Notifications */}
      <AnimatePresence>
        {killNotifications.map((notif) => {
          const sx = (notif.x - cameraState.x) * cameraState.zoom + (canvasRef.current?.width || 0) / 2;
          const sy = (notif.y - cameraState.y) * cameraState.zoom + (canvasRef.current?.height || 0) / 2;

          return (
            <motion.div
              key={notif.id}
              initial={{ opacity: 0, x: sx, y: sy, scale: 0.5 }}
              animate={{ opacity: 1, x: sx + 40, y: sy - 60, scale: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.3 } }}
              className="absolute pointer-events-none z-[80] font-black italic uppercase tracking-tighter flex items-center gap-2"
              style={{ left: 0, top: 0 }}
            >
              <span className="text-red-500 text-shadow-glow">KILLED</span>
              <span className="text-white text-xl drop-shadow-[0_0_10px_rgba(255,255,255,0.5)]">{notif.name}</span>
            </motion.div>
          );
        })}
      </AnimatePresence>

      {/* Controls Overlay */}
      <div className="absolute bottom-8 right-8 flex gap-3 pointer-events-auto z-[70]">
        {/* Menu Button as requested: "put the menu button right next to the 3 [buttons]" */}
        <button
          onClick={() => {
            if (isFullscreen) return;
            window.dispatchEvent(new CustomEvent('open-neon-arcade-menu'));
          }}
          disabled={isFullscreen}
          className={`p-4 bg-white/5 border border-white/10 rounded-2xl text-[#00FFD1] transition-all shadow-2xl flex items-center justify-center select-none ${
            isFullscreen 
              ? "opacity-30 cursor-not-allowed pointer-events-none" 
              : "hover:bg-[#00FFD1]/10 hover:border-[#00FFD1]/50 cursor-pointer"
          }`}
          title={isFullscreen ? "Menu disabled in Fullscreen" : "Open Navigation Menu"}
        >
          <Menu className="w-6 h-6" />
        </button>

        {/* Volume/Mute Button: "put a volume icon next to the full screen and exit button... that allow users to mute" */}
        <button
          onClick={toggleMute}
          className="p-4 bg-white/5 border border-white/10 rounded-2xl text-[#00FFD1] hover:bg-[#00FFD1]/10 hover:border-[#00FFD1]/50 transition-all shadow-2xl flex items-center justify-center cursor-pointer select-none"
          title={isMuted ? "Unmute Sound" : "Mute Sound"}
        >
          {isMuted ? <VolumeX className="w-6 h-6 text-red-500" /> : <Volume2 className="w-6 h-6" />}
        </button>

        <button 
          onClick={toggleFullscreen}
          className="p-4 bg-white/5 border border-white/10 rounded-2xl text-[#00FFD1] hover:bg-[#00FFD1]/10 hover:border-[#00FFD1]/50 transition-all shadow-2xl"
        >
          {isFullscreen ? <Minimize className="w-6 h-6" /> : <Maximize className="w-6 h-6" />}
        </button>
        {/* Pug-style pause menu (inline pill — lives in this control
            cluster). THE exit path; replaces the back chevron. Mid-match the
            guard owns the click: confirm → forfeit → results → progression
            → only then the exit runs. */}
        <GamePauseMenu
                inline
                onExit={() => requestExit(onExit)}
                exitLabel="Exit Game"
                onOpenChange={(open) => {
                  menuPausedRef.current = open;
                }}
              />
      </div>

      {/* Cashout Button for Free Play Wager */}
      {gameState === 'playing' && wagerMode === 'free_play' && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-[70] pointer-events-auto">
          <button
            onMouseDown={handleCashoutDown}
            onMouseUp={handleCashoutUp}
            onMouseLeave={handleCashoutUp}
            onTouchStart={handleCashoutDown}
            onTouchEnd={handleCashoutUp}
            className={`px-8 py-4 rounded-xl font-mono text-xs font-black tracking-widest uppercase border select-none transition-all ${
              canCashout
                ? 'bg-yellow-500/10 border-yellow-500 text-yellow-500 shadow-[0_0_20px_rgba(234,179,8,0.2)] hover:bg-yellow-500/25 active:scale-95 cursor-pointer'
                : 'bg-white/5 border-white/10 text-white/30 cursor-not-allowed'
            }`}
          >
            <div className="flex items-center justify-center gap-1.5">
              {canCashout ? (
                <>HOLD TO CASHOUT <img src="/neon-bucks-icon.png" alt="NB" referrerPolicy="no-referrer" className="h-5 w-auto drop-shadow-[0_0_5px_rgba(234,179,8,0.5)]" /></>
              ) : (
                'GET A KILL TO CASHOUT'
              )}
            </div>
          </button>
          {cashoutHoldProgress > 0 && (
            <div className="w-48 h-1.5 bg-black/40 rounded-full overflow-hidden border border-white/10 backdrop-blur-md">
              <motion.div
                className="h-full bg-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.5)]"
                animate={{ width: `${cashoutHoldProgress * 100}%` }}
                transition={{ duration: 0.1 }}
              />
            </div>
          )}
        </div>
      )}

      {/* ONLINE: matchmaking. Shown IMMEDIATELY on entry for slayer/lms —
          never waits for a server ack. free_play never shows this screen. */}
      {netSearching && isQueuedOnline && (
        <SearchingForMatch
          variant="overlay"
          playersInQueue={netQueue.current}
          playersNeeded={netQueue.needed}
          subtitle={`Neon Cells · ${onlineLabel}`}
          onCancel={() => {
            netRef.current?.cancel();
            netRef.current = null;
            setNetSearching(false);
            onExit();
          }}
        />
      )}

      {/* ONLINE (lobby modes): match found — the server's start countdown. */}
      {isQueuedOnline && !netSearching && netMatch?.status === 'waiting' && gameState === 'playing' && (
        <div className="absolute inset-0 z-[90] flex items-center justify-center pointer-events-none bg-black/60 backdrop-blur-sm">
          <div className="text-center space-y-3">
            <p className="text-[#00FFD1] font-mono text-sm tracking-[0.4em] uppercase">Match found</p>
            <p className="text-8xl font-black italic text-white">{Math.ceil(netMatch.startsIn / 1000)}</p>
            <p className="text-white/50 font-mono text-xs uppercase tracking-widest">
              {netMatch.total} players
            </p>
          </div>
        </div>
      )}

      {/* ONLINE: respawn countdown after a player kill (free play) */}
      {isNetworkMode && respawnInfo && gameState === 'playing' && (
        <div className="absolute inset-0 z-[85] flex items-center justify-center pointer-events-none bg-black/50 backdrop-blur-sm">
          <div className="text-center space-y-3">
            <p className="text-red-500 font-mono text-sm tracking-[0.4em] uppercase">Consumed by {respawnInfo.by}</p>
            <p className="text-8xl font-black italic text-white">{respawnRemaining.toFixed(1)}s</p>
            <p className="text-white/50 font-mono text-xs uppercase tracking-widest">Redeploying</p>
          </div>
        </div>
      )}

      {/* ONLINE (slayer): killed out of the field, waiting for the kill board.
          Slayer has no defeat screen — the match is still running for others. */}
      {isNetworkMode && netEliminated && gameState === 'playing' && (
        <div className="absolute inset-0 z-[86] flex items-center justify-center pointer-events-none bg-black/70 backdrop-blur-sm">
          <div className="text-center space-y-3">
            <p className="text-red-500 font-mono text-sm tracking-[0.4em] uppercase">Eliminated</p>
            <p className="text-6xl font-black italic text-white uppercase tracking-tighter">{kills} Kills</p>
            <p className="text-white/50 font-mono text-xs uppercase tracking-widest">
              No winner in Slayer — waiting for the final kill board
            </p>
          </div>
        </div>
      )}

      {/* ONLINE: joining indicator until the first server state lands */}
      {isNetworkMode && !netSearching && gameState === 'playing' && !netJoined && (
        <div className="absolute inset-0 z-[85] flex items-center justify-center pointer-events-none">
          <p className="text-[#00FFD1] font-mono text-sm tracking-[0.4em] uppercase animate-pulse">Linking to Grid...</p>
        </div>
      )}

      {/* NETWORK MODE: server-side join/session errors */}
      {netError && (
        <div className="absolute top-24 left-1/2 -translate-x-1/2 z-[110] bg-red-500/20 border border-red-500/50 backdrop-blur-md px-6 py-3 rounded-xl">
          <p className="text-red-400 font-mono text-xs uppercase tracking-widest">{netError}</p>
        </div>
      )}

      {/* Menus */}
      <AnimatePresence>
        {gameState === 'menu' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[60] bg-black/80 backdrop-blur-xl flex items-center justify-center p-6"
          >
            <div className="max-w-md w-full text-center space-y-8">
              <div className="space-y-2">
                <h2 className="text-6xl font-black italic uppercase text-white tracking-tighter">Neon Cells</h2>
                <p className="text-[#00FFD1] font-mono tracking-[0.3em] uppercase">Ready for Deployment</p>
              </div>

              <div className="space-y-4 p-8 bg-white/5 border border-white/10 rounded-3xl text-left">
                <div className="flex items-center gap-4 text-white/60">
                  <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center font-mono">M</div>
                  <p className="text-xs uppercase tracking-widest font-bold font-mono">MOUSE - NAVIGATE</p>
                </div>
                <div className="flex items-center gap-4 text-white/60">
                  <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center font-mono">S</div>
                  <p className="text-xs uppercase tracking-widest font-bold font-mono">SPACE - SPLIT CELL</p>
                </div>
                <div className="flex items-center gap-4 text-white/60">
                  <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center font-mono font-bold text-[10px]">SHIFT</div>
                  <p className="text-xs uppercase tracking-widest font-bold font-mono">L-SHIFT - SPEED BOOST</p>
                </div>
                <div className="flex items-center gap-4 text-white/60">
                  <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center font-mono">?</div>
                  <p className="text-xs uppercase tracking-widest font-bold font-mono">HOLD SPACE - MERGE CELLS</p>
                </div>
                <div className="flex items-center gap-4 text-white/60">
                  <div className="w-8 h-8 rounded-lg bg-[#00FFD1]/20 flex items-center justify-center text-[#00FFD1]">!</div>
                  <p className="text-[10px] uppercase tracking-widest font-mono italic">CONSUME SMALLER ENTITIES TO GROW</p>
                </div>
              </div>

              <button 
                onClick={startGame}
                className="w-full bg-[#00FFD1] text-[#081616] font-black py-5 rounded-2xl text-xl uppercase italic tracking-tighter hover:scale-105 transition-all shadow-[0_0_50px_rgba(0,255,209,0.3)]"
              >
                INITIALIZE CORE
              </button>
            </div>
          </motion.div>
        )}

        {/* SLAYER (online): the kill board replaces the victory/defeat screen. */}
        {gameState === 'gameOver' && isNetworkMode && netResult?.scoring === 'kills' && (
          <SlayerScoreboard
            result={netResult}
            gameMode={onlineLabel}
            onRematch={resetGame}
            onExit={() => requestExit(onExit)}
          />
        )}

        {gameState === 'gameOver' && !(isNetworkMode && netResult?.scoring === 'kills') && (
          <ResultsScreen
            won={gameResult === 'win'}
            stake={isNetworkMode ? 0 : (wagerMode ? wagerAmount : 0)}
            winnings={isNetworkMode ? 0 : (wagerMode ? sessionWinnings : 0)}
            gameMode={isNetworkMode
              ? `Online - ${onlineLabel}`
              : (wagerMode ? `Practice Wager - ${wagerMode}` : 'Practice')}
            // Online stakes nothing — hide the Wagered/Payout rows.
            moneyless={isNetworkMode}
            kills={kills}
            note={forfeited ? 'You left the match — counted as a loss' : null}
            onRematch={resetGame}
            onExit={() => requestExit(onExit)}
          />
        )}
      </AnimatePresence>

      {/* Level progression, chained after the practice results screen.
          Practice pays XP only (rank is null by construction); online
          freeplay has no client progression payload today. When a
          forfeit-exit is pending, its close cues the deferred navigation. */}
      <PostGameProgression
        progression={practiceProgression}
        onDone={() => {
          clearPracticeProgression();
          finishExit();
        }}
      />

      {/* Mid-run "are you sure? leaving forfeits" dialog (z-[130]). */}
      {confirmDialog}
    </div>
  );
};

export default ArgarGame;
