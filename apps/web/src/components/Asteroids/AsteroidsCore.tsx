import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RefreshCw, Gamepad2, Trophy, Heart, Target, Navigation, Skull, Maximize, Flame, Zap, Sword, ShieldAlert, Radiation, Menu, Volume2, VolumeX } from 'lucide-react';
import GameBackButton from '../common/GameBackButton';
import { useGunSound } from './useGunSound';
import { useGameAudio } from './useGameAudio';
import { ResultsScreen } from '../NeonBucks/ResultsScreen';
import { useNeonBucks } from '../../NeonBucksStore';
import {
  FreeplayNet,
  FREE_PLAY_DIFFICULTY,
  type FreeplayMode,
  type FreeplaySector,
  type MatchState,
  type MatchResult,
} from '../../lib/freeplayNet';
import SearchingForMatch from '../common/SearchingForMatch';

interface AsteroidsGameProps {
  onExit: () => void;
  profile?: { name: string; avatarUrl: string } | null;
  difficulty?: number;
  isMultiplayer?: boolean;
  /** The ONLINE mode chosen in the lobby. Null = practice/local play. */
  onlineMode?: FreeplayMode | null;
  /** The ONLINE sector chosen in the lobby (eclipse/blitz). Null = practice. */
  onlineSector?: FreeplaySector | null;
  wagerAmount?: number;
  wagerMode?: 'free_play' | 'slayer' | 'lms' | null;
  targetKills?: number;
}

interface GameObject {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  rotation?: number;
  rotationSpeed?: number;
  health?: number;
  id?: string;
  type?: 'asteroid' | 'bullet' | 'particle' | 'bot' | 'trail';
  subType?: 'normal' | 'health' | 'ammo';
  color?: string;
  lifetime?: number;
  maxLifetime?: number;
  angle?: number;
  angularVelocity?: number;
  nickname?: string;
  score?: number;
  angularFriction?: number;
  friction?: number;
  kills?: number;
  acceleration?: number;
  magazine?: number;
  reserve?: number;
  reloadTimer?: number;
  boostReserve?: number;
}

const WORLD_SIZE = 8000;

interface DamageIndicator {
  id: string;
  x: number;
  y: number;
  value: number;
  lifetime: number;
}

interface KillNotification {
  id: string;
  nickname: string;
  lifetime: number;
}

/**
 * SLAYER RESULT — a ranked KILL BOARD, not a verdict.
 *
 * Contract: "SLAYER has NO winner. Everybody scores points for the kills they
 * got." So no Victory/Defeat headline and no money — every pilot is listed
 * with the kills they scored, ranked, with our own row highlighted. LMS still
 * uses the normal win/lose ResultsScreen.
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
          <span className="flex-1 px-3">Pilot · {gameMode}</span>
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

const AsteroidsCore: React.FC<AsteroidsGameProps> = ({ onExit, profile, difficulty: difficultyProp = 1, isMultiplayer = false, onlineMode = null, onlineSector = null, wagerAmount = 0, wagerMode = null, targetKills }) => {
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
  // payload, and the zone visuals key off exactly that number — the old
  // `difficulty = 1` hard-code disabled every zone code path online.
  //
  // The ref is what the rAF loop and draw() read: the loop closure is captured
  // by an effect keyed on [gameState, dimensions], so a state change alone
  // would never reach it. The state drives the React HUD.
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
  /** The difficulty the CANVAS must gate zone drawing on (loop-safe). */
  const zoneDifficulty = () =>
    isNetworkMode
      ? netHasZoneRef.current
        ? netDifficultyRef.current
        : FREE_PLAY_DIFFICULTY
      : difficulty;

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  // Online skips the briefing menu entirely (the lobby click was the start),
  // so it begins in 'playing' — no one-frame menu flash.
  const [gameState, setGameState] = useState<'menu' | 'playing' | 'gameover' | 'victory'>(
    isNetworkMode ? 'playing' : 'menu'
  );
  const [score, setScore] = useState(0);
  const [kills, setKills] = useState(0);
  const [health, setHealth] = useState(100);
  const [ammo, setAmmo] = useState({ magazine: 100, reserve: 30, reloading: false });
  const [isBoosting, setIsBoosting] = useState(false);
  const [boostReserveState, setBoostReserveState] = useState(0);
  
  const damageIndicatorsRef = useRef<{ id: string; x: number; y: number; value: number; lifetime: number }[]>([]);
  const killNotificationsRef = useRef<{ id: string; nickname: string; lifetime: number }[]>([]);
  const hitmarkersRef = useRef<{ id: string; time: number; x: number; y: number }[]>([]);
  const lastHudUpdateRef = useRef(Date.now());
  const currentZoomRef = useRef(1);
  const MAX_OUTSIDE_TIME = 10;

  const requestRef = useRef<number | undefined>(undefined);
  const lastTimeRef = useRef<number | undefined>(undefined);
  const keysRef = useRef<Record<string, boolean>>({});
  
  // Camera state
  const cameraRef = useRef({ x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 });

  // Zone State (Using Refs for loop to avoid stale closures)
  const zoneRef = useRef({
    radius: WORLD_SIZE,
    x: WORLD_SIZE / 2,
    y: WORLD_SIZE / 2,
    safeZone: { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, radius: WORLD_SIZE },
    nextSafeZone: null as any,
    isShrinking: false,
    phaseTimer: 30,
    phase: 1,
    outsideTimer: 0,
    countdownTimer: null as number | null
  });

  // State versions for UI rendering only
  const [uiZone, setUiZone] = useState({
    radius: WORLD_SIZE,
    x: WORLD_SIZE / 2,
    y: WORLD_SIZE / 2,
    outsideTimer: 0,
    phaseTimer: 30,
    countdownTimer: null as number | null
  });

  const [playerPos, setPlayerPos] = useState({ x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 });

  // Game state refs for the loop
  const playerRef = useRef({
    x: WORLD_SIZE / 2,
    y: WORLD_SIZE / 2,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2,
    angularVelocity: 0,
    radius: 15,
    rotationSpeed: 0.008,
    angularFriction: 0.88,
    acceleration: 0.2,
    friction: 0.98,
    isHit: false,
    hitTimer: 0,
    kills: 0,
    magazine: 100,
    reserve: 30,
    reloadTimer: 0,
    boostReserve: 0
  });

  const bulletsRef = useRef<GameObject[]>([]);
  const asteroidsRef = useRef<GameObject[]>([]);
  const botsRef = useRef<GameObject[]>([]);
  const particlesRef = useRef<GameObject[]>([]);
  const spawnTimerRef = useRef(0);
  const botSpawnTimerRef = useRef(0);
  const starsRef = useRef<{x: number, y: number, size: number, opacity: number}[]>([]);
  const isShootingRef = useRef(false);
  const lastShootTimeRef = useRef(0);
  const leaderboardRef = useRef<any[]>([]);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [reloadProgress, setReloadProgress] = useState(0); // 0 to 1
  const isUiReloaderHeldRef = useRef(false);
  const reloadHoldTimeRef = useRef(0);

  // ── Network-mode session state (online play) ──────────────────────────────
  const netRef = useRef<FreeplayNet | null>(null);
  const netInputRef = useRef<{ turn: -1 | 0 | 1; shoot: boolean; reload: boolean }>({ turn: 0, shoot: false, reload: false });
  const netKillsRef = useRef(0); // loop-side copy of kills for the zoom camera
  const netBotCacheRef = useRef(new Map<string, GameObject>()); // player id -> ship adapter
  const netAsteroidCacheRef = useRef(new Map<string | number, GameObject>()); // asteroid id -> adapter (keeps cosmetic spin)
  const netServerAmmoRef = useRef({ magazine: 30, reloading: false }); // gates the local gun sound
  const reloadPulseUntilRef = useRef(0); // UI reload click -> short reload-input pulse
  const [netJoined, setNetJoined] = useState(false);
  // Matchmaking (slayer/lms only) — set optimistically on entry, never
  // waiting for a server ack.
  const [netSearching, setNetSearching] = useState(false);
  const [netQueue, setNetQueue] = useState({ current: 1, needed: 2 });
  // Lobby-match lifecycle (waiting -> running -> ended) for the countdown.
  const [netMatch, setNetMatch] = useState<MatchState | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  // The server's end-of-match scoreboard. SLAYER renders it as a ranked kill
  // board (no winner); LMS keeps the win/lose ResultsScreen.
  const [netResult, setNetResult] = useState<MatchResult | null>(null);
  // SLAYER only: killed out of the field while the match runs on — no verdict
  // to show yet, just wait for the board.
  const [netEliminated, setNetEliminated] = useState(false);
  const [respawnInfo, setRespawnInfo] = useState<{ by: string; until: number } | null>(null);
  const [respawnRemaining, setRespawnRemaining] = useState(0);

  // Persistent counters to guarantee deterministic 1:10 and 1:15 spawn ratios
  const spawnedRegularCountRef = useRef(0);
  const spawnedHealthCountRef = useRef(0);
  const spawnedAmmoCountRef = useRef(0);

  const getNextAsteroidTypeAndColor = () => {
    let subType: 'normal' | 'health' | 'ammo' = 'normal';
    let color = '#ffffff';

    // Check ratios:
    // If we've spawned enough regular ones, spawn health/ammo to maintain the exact ratio
    if (spawnedRegularCountRef.current >= (spawnedHealthCountRef.current + 1) * 10) {
      subType = 'health';
      color = '#00ff44';
      spawnedHealthCountRef.current += 1;
    } else if (spawnedRegularCountRef.current >= (spawnedAmmoCountRef.current + 1) * 15) {
      subType = 'ammo';
      color = '#00aaff';
      spawnedAmmoCountRef.current += 1;
    } else {
      subType = 'normal';
      color = '#ffffff';
      spawnedRegularCountRef.current += 1;
    }

    return { subType, color };
  };

  const { triggerShot, triggerReload } = useGunSound();
  const { playHitmarker, playKillSound, playCritHit, playKillstreakSound, playDeath } = useGameAudio();

  // Constants
  const SHOOT_INTERVAL = 60000 / 800; // ~75ms for 800 RPM (Blaster style)
  const [streakNotification, setStreakNotification] = useState<{ text: string, icon: React.ReactNode, id: number } | null>(null);
  const nukeTriggeredRef = useRef(false);

  // Fullscreen state
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

  // Cash-out is a PRACTICE Neon Bucks feature. Online has no pot to cash out,
  // so the button is not rendered there at all (wagerMode is null online).
  const canCashout = kills > 0;

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
           if (p >= 1) {
               setIsCashingOut(false);
               setGameState('victory'); // Victory gives the cash and triggers game over screen
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

  // Generate stars once for the large world
  useEffect(() => {
    const starCount = 1000;
    const newStars = [];
    for (let i = 0; i < starCount; i++) {
        newStars.push({
            x: Math.random() * WORLD_SIZE,
            y: Math.random() * WORLD_SIZE,
            size: Math.random() < 0.1 ? Math.random() * 2 + 1 : Math.random() * 1.5,
            opacity: 0.1 + Math.random() * 0.8
        });
    }
    starsRef.current = newStars;
  }, []);

  // Initialize and handle resize
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Handle keyboard input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      keysRef.current[e.key.toLowerCase()] = true;
      if (e.key.toLowerCase() === 'f' && !e.repeat) {
        toggleFullscreen();
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      keysRef.current[e.key.toLowerCase()] = false;
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const shoot = useCallback(() => {
    if (gameState !== 'playing') return;
    if (playerRef.current.magazine <= 0) return;
    if ((playerRef.current.reloadTimer || 0) > 0) return;

    triggerShot();

    const player = playerRef.current;
    
    // Deduct ammo
    player.magazine--;
    setAmmo(a => ({ ...a, magazine: player.magazine }));

    const bulletSpeed = 20;
    // Add only the component of player velocity that is in the firing direction
    const forwardVelocity = (player.vx * Math.cos(player.angle) + player.vy * Math.sin(player.angle));
    const finalSpeed = bulletSpeed + Math.max(0, forwardVelocity);
    
    const bullet: GameObject = {
      x: player.x + Math.cos(player.angle) * 20,
      y: player.y + Math.sin(player.angle) * 20,
      vx: Math.cos(player.angle) * finalSpeed,
      vy: Math.sin(player.angle) * finalSpeed,
      rotation: player.angle,
      radius: 3,
      type: 'bullet',
      color: '#00FFD1'
    };
    bulletsRef.current.push(bullet);

    // Muzzle flash particle
    for (let i = 0; i < 3; i++) {
        particlesRef.current.push({
            x: bullet.x,
            y: bullet.y,
            vx: (Math.random() - 0.5) * 5,
            vy: (Math.random() - 0.5) * 5,
            radius: Math.random() * 2,
            lifetime: 20,
            color: '#00FFD1',
            type: 'particle'
        });
    }
  }, [gameState]);

  // Handle mouse click to shoot
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
        if (e.button === 0) isShootingRef.current = true;
    };
    const handleMouseUp = (e: MouseEvent) => {
        if (e.button === 0) isShootingRef.current = false;
    };
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
        window.removeEventListener('mousedown', handleMouseDown);
        window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const [sessionWinnings, setSessionWinnings] = useState(0);
  const { win, wager, isFirstPractice } = useNeonBucks();

  useEffect(() => {
    if (gameState === 'gameover' || gameState === 'victory') {
       // ONLINE HAS NO MONEY THIS PASS: never call wager()/win() online.
       // (wagerMode is null on the online path, so this block is doubly
       // guarded — the isNetworkMode check documents the intent.)
       if (!isNetworkMode && wagerAmount > 0 && wagerMode) {
          if (wagerMode === 'free_play') {
             if (gameState === 'victory') { // manual cashout sets to victory
                 const payout = playerRef.current.kills * wagerAmount;
                 win(payout);
                 setSessionWinnings(payout);
             } else {
                 setSessionWinnings(0 - wagerAmount);
             }
          } else if (wagerMode === 'slayer') {
             const payout = playerRef.current.kills * wagerAmount;
             if (payout > 0) win(payout);
             setSessionWinnings(payout - wagerAmount);
          } else if (wagerMode === 'lms') {
             if (gameState === 'victory') {
                const totalBots = difficulty <= 3 ? 25 : 35; 
                const pot = (totalBots + 1) * wagerAmount;
                 win(pot);
                 setSessionWinnings(pot - wagerAmount);
             } else {
                 setSessionWinnings(0 - wagerAmount);
             }
          }
       }
       // Slayer has no loser: a kill board is not a death screen, so it gets
       // no death sting either.
       const slayerBoard = isNetworkMode && netResult?.scoring === 'kills';
       if (gameState === 'gameover' && !slayerBoard) playDeath();
    }
  }, [gameState, playDeath, wagerAmount, wagerMode, win, difficulty]);

  const createExplosion = (x: number, y: number, color: string, count: number = 10) => {
    for (let i = 0; i < count; i++) {
        particlesRef.current.push({
            x,
            y,
            vx: (Math.random() - 0.5) * 10,
            vy: (Math.random() - 0.5) * 10,
            radius: Math.random() * 3,
            lifetime: 40 + Math.random() * 20,
            color,
            type: 'particle'
        });
    }
  };

  const generateNextZone = (current: { x: number; y: number; radius: number }) => {
    const shrinkFactor = (difficulty === 12 || difficulty === 13) ? 0.3 : 0.5;
    const nextRadius = current.radius * shrinkFactor;
    const maxOffset = current.radius - nextRadius;
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * maxOffset;
    return {
      x: current.x + Math.cos(angle) * distance,
      y: current.y + Math.sin(angle) * distance,
      radius: nextRadius,
    };
  };

  const updateZone = (dt: number) => {
    if (difficulty === 1 || difficulty === 2 || difficulty === 3) return;
    
    const zone = zoneRef.current;
    
    // Timer update (dt is frames, translate to seconds)
    zone.phaseTimer -= (dt / 60);

    if (zone.isShrinking) {
      if (difficulty >= 10 && zone.nextSafeZone) {
        // Move towards target
        const totalDuration = (difficulty === 12 || difficulty === 13) ? (zone.phase > 1 ? 10 : 20) : 30;
        // Remaining distance interpolation
        const stepFraction = Math.min(1, (dt / 60) / Math.max(0.01, zone.phaseTimer));
        
        zone.x += (zone.nextSafeZone.x - zone.x) * stepFraction;
        zone.y += (zone.nextSafeZone.y - zone.y) * stepFraction;
        zone.radius += (zone.nextSafeZone.radius - zone.radius) * stepFraction;
      } else {
        const shrinkSpeed = (difficulty === 11 || difficulty === 13 ? 2.5 : 1.5) * dt;
        zone.radius = Math.max(100, zone.radius - shrinkSpeed);
      }
    }

    if (zone.phaseTimer <= 0) {
      if (zone.isShrinking) {
        // Stop shrinking, start waiting
        zone.isShrinking = false;
        zone.countdownTimer = null;
        
        // Update current safe zone to reached target
        if (zone.nextSafeZone) {
          zone.safeZone = { ...zone.nextSafeZone };
          zone.nextSafeZone = generateNextZone(zone.safeZone);
        } else {
          zone.safeZone = { x: zone.x, y: zone.y, radius: zone.radius };
          if (difficulty >= 10) zone.nextSafeZone = generateNextZone(zone.safeZone);
        }
        
        // Blitz (12, 13) has 15s stability, others 30s
        zone.phaseTimer = (difficulty === 12 || difficulty === 13) ? 15 : 30;
      } else {
        // Stop waiting, start shrinking
        zone.isShrinking = true;
        zone.phase += 1;
        
        // Set duration for the shrink phase
        if (difficulty === 12 || difficulty === 13) {
          zone.phaseTimer = zone.phase > 1 ? 10 : 20;
        } else {
          zone.phaseTimer = 30;
        }
      }
    }
    
    // Blitz Specific: 3s countdown before shrink starts
    if (!zone.isShrinking && (difficulty === 12 || difficulty === 13) && zone.phaseTimer <= 3) {
      zone.countdownTimer = zone.phaseTimer;
    } else {
      zone.countdownTimer = null;
    }

    const dx = playerRef.current.x - zone.x;
    const dy = playerRef.current.y - zone.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist > zone.radius) {
      if (difficulty >= 10) {
        // Instant kill for Eclipse and Blitz
        setHealth(0);
        setGameState('gameover');
      } else {
        zone.outsideTimer += (dt / 60);
        if (zone.outsideTimer >= MAX_OUTSIDE_TIME) {
          setHealth(0);
          setGameState('gameover');
        }
        const damageMultiplier = 0.1;
        setHealth(h => Math.max(0, h - damageMultiplier * dt));
      }
    } else {
      zone.outsideTimer = Math.max(0, zone.outsideTimer - (dt / 30));
    }

    // Sync to UI state periodically (or every frame if needed for HUD)
    // We can do it every frame because these are simple primitives
    setUiZone({
      radius: zone.radius,
      x: zone.x,
      y: zone.y,
      outsideTimer: zone.outsideTimer,
      phaseTimer: zone.phaseTimer,
      countdownTimer: zone.countdownTimer
    });
  };

  const updateBots = (dt: number) => {
    if (isMultiplayer) return;

    let botCapacity = 50;
    if (difficulty <= 3) botCapacity = 25;
    if (difficulty >= 10) botCapacity = 35; // Decreased for Eclipse/Blitz modes

    const canSpawn = difficulty < 10; // Disable respawns for Eclipse and Blitz modes

    botSpawnTimerRef.current -= dt;
    if (canSpawn && botSpawnTimerRef.current <= 0 && botsRef.current.length < botCapacity) {
      let x, y;
      if (difficulty >= 10) {
        // Spawn inside the current zone for hardcore modes
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * (zoneRef.current.radius * 0.7);
        x = zoneRef.current.x + Math.cos(angle) * dist;
        y = zoneRef.current.y + Math.sin(angle) * dist;
      } else {
        // Spawn at edges for free sectors
        const angle = Math.random() * Math.PI * 2;
        x = WORLD_SIZE / 2 + Math.cos(angle) * (WORLD_SIZE * 0.45);
        y = WORLD_SIZE / 2 + Math.sin(angle) * (WORLD_SIZE * 0.45);
      }

      // Sometimes spawn a small cluster
      const clusterSize = Math.random() > 0.8 ? 3 : 1;
      for (let i = 0; i < clusterSize; i++) {
        const offsetAngle = Math.random() * Math.PI * 2;
        const offsetDist = Math.random() * 50;
        
        botsRef.current.push({
          id: `bot-${Math.random().toString(36).substr(2, 5)}`,
          x: x + Math.cos(offsetAngle) * offsetDist,
          y: y + Math.sin(offsetAngle) * offsetDist,
          vx: 0, vy: 0,
          angle: Math.random() * Math.PI * 2,
          angularVelocity: 0,
          radius: 15,
          rotationSpeed: 0.008,
          angularFriction: 0.88,
          acceleration: 0.18,
          friction: 0.98,
          type: 'bot',
          nickname: `PILOT-${Math.floor(Math.random() * 9000 + 1000)}`,
          health: 100,
          score: Math.floor(Math.random() * 2000),
          kills: Math.floor(Math.random() * 5),
          magazine: 30,
          reserve: 30,
          reloadTimer: 0
        });
      }
      
      // Diversified spawn timer
      if (difficulty >= 10) {
        // High variation for hardcore modes
        const rand = Math.random();
        if (rand > 0.9) {
          // Occasional longer pause
          botSpawnTimerRef.current = 600 + Math.random() * 600;
        } else if (rand > 0.4) {
          // Medium intervals
          botSpawnTimerRef.current = 180 + Math.random() * 180;
        } else {
          // Rapid harassment
          botSpawnTimerRef.current = 30 + Math.random() * 60;
        }
      } else {
        botSpawnTimerRef.current = (difficulty <= 3) 
          ? (Math.random() * 100 + 100) 
          : (Math.random() * 300 + 300); 
      }    }

    botsRef.current.forEach(bot => {
      // Find nearest target (Player, other Bots)
      let nearestTarget = { x: playerRef.current.x, y: playerRef.current.y, dist: 9999 };
      
      const dxP = playerRef.current.x - bot.x;
      const dyP = playerRef.current.y - bot.y;
      nearestTarget.dist = Math.sqrt(dxP * dxP + dyP * dyP);

      // Check other bots
      for (let i = 0; i < Math.min(botsRef.current.length, 10); i++) {
        const other = botsRef.current[i];
        if (other.id === bot.id) continue;
        const dx = other.x - bot.x;
        const dy = other.y - bot.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < nearestTarget.dist) {
          nearestTarget = { x: other.x, y: other.y, dist: d };
        }
      }

      // AVOIDANCE: Asteroids
      let avoidanceVector = { x: 0, y: 0 };
      let inDanger = false;
      
      for (let i = 0; i < asteroidsRef.current.length; i++) {
        const ast = asteroidsRef.current[i];
        const dx = bot.x - ast.x;
        const dy = bot.y - ast.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < ast.radius + 150) {
          inDanger = true;
          avoidanceVector.x += (dx / dist) * (200 / dist);
          avoidanceVector.y += (dy / dist) * (200 / dist);
        }
      }

      // AVOIDANCE: Zone boundary
      if (difficulty >= 10) {
        const dxZ = bot.x - zoneRef.current.x;
        const dyZ = bot.y - zoneRef.current.y;
        const distZ = Math.sqrt(dxZ * dxZ + dyZ * dyZ);
        
        if (distZ > zoneRef.current.radius * 0.7) {
          inDanger = true;
          const toCenterX = zoneRef.current.x - bot.x;
          const toCenterY = zoneRef.current.y - bot.y;
          const distToCenter = Math.max(1, Math.sqrt(toCenterX * toCenterX + toCenterY * toCenterY));
          avoidanceVector.x += (toCenterX / distToCenter) * 2;
          avoidanceVector.y += (toCenterY / distToCenter) * 2;
        }
      }

      let tx = nearestTarget.x;
      let ty = nearestTarget.y;

      if (inDanger) {
        tx = bot.x + avoidanceVector.x * 500;
        ty = bot.y + avoidanceVector.y * 500;
      }

      const dxFinal = tx - bot.x;
      const dyFinal = ty - bot.y;
      const targetAngle = Math.atan2(dyFinal, dxFinal);

      // AI angular logic
      let angleDiff = targetAngle - (bot.angle || 0);
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

      bot.angularVelocity = (bot.angularVelocity || 0) + angleDiff * (bot.rotationSpeed || 0.008) * dt;
      bot.angle = (bot.angle || 0) + (bot.angularVelocity || 0) * dt;
      bot.angularVelocity *= (bot.angularFriction || 0.88);

      const accel = inDanger ? 0.25 : 0.18;
      bot.vx += Math.cos(bot.angle || 0) * accel * dt;
      bot.vy += Math.sin(bot.angle || 0) * accel * dt;

      // Physics
      bot.x += bot.vx * dt;
      bot.y += bot.vy * dt;
      bot.vx *= (bot.friction || 0.98);
      bot.vy *= (bot.friction || 0.98);

      // Barrier Logic instead of Wrap
      if (bot.x < bot.radius) { bot.x = bot.radius; bot.vx *= -0.5; }
      if (bot.x > WORLD_SIZE - bot.radius) { bot.x = WORLD_SIZE - bot.radius; bot.vx *= -0.5; }
      if (bot.y < bot.radius) { bot.y = bot.radius; bot.vy *= -0.5; }
      if (bot.y > WORLD_SIZE - bot.radius) { bot.y = WORLD_SIZE - bot.radius; bot.vy *= -0.5; }

      // AI Shooting and Reloading
      if (bot.magazine === undefined) bot.magazine = 30;
      if (bot.reserve === undefined) bot.reserve = 30;
      if (bot.reloadTimer === undefined) bot.reloadTimer = 0;

      if (bot.reloadTimer > 0) {
        bot.reloadTimer -= dt / 60;
        if (bot.reloadTimer <= 0) {
           const needed = 30 - bot.magazine;
           if (needed > 0 && bot.reserve > 0) {
              const toReload = Math.min(needed, bot.reserve);
              bot.magazine += toReload;
              bot.reserve -= toReload;
           }
        }
      } else if (bot.magazine <= 0 && bot.reserve > 0) {
         bot.reloadTimer = 1.5; // 1.5 seconds reload time for AI
      } else if (!inDanger && nearestTarget.dist < 800 && Math.random() < 0.02 * dt && bot.magazine > 0) {
        bot.magazine--;
        const bulletSpeed = 20; 
        const botAngle = bot.angle || 0;
        const forwardVel = (bot.vx * Math.cos(botAngle) + bot.vy * Math.sin(botAngle));
        const finalSpeed = bulletSpeed + Math.max(0, forwardVel);

        bulletsRef.current.push({
          x: bot.x + Math.cos(botAngle) * 20,
          y: bot.y + Math.sin(botAngle) * 20,
          vx: Math.cos(botAngle) * finalSpeed,
          vy: Math.sin(botAngle) * finalSpeed,
          rotation: botAngle,
          radius: 3,
          type: 'bullet',
          color: '#FF0080',
          id: bot.id
        });
      }
    });

    // Cleanup dead bots or those outside zone in hardcore modes
    botsRef.current = botsRef.current.filter(bot => {
      if (difficulty >= 10) {
        const dxZ = bot.x - zoneRef.current.x;
        const dyZ = bot.y - zoneRef.current.y;
        const distZ = Math.sqrt(dxZ * dxZ + dyZ * dyZ);
        if (distZ > zoneRef.current.radius) {
          createExplosion(bot.x, bot.y, '#FF0080', 20);
          return false;
        }
      }
      return (bot.health || 0) > 0;
    });

    // Victory condition for Last Pilot Standing
    if (difficulty >= 10 && botsRef.current.length === 0 && health > 0) {
      setGameState('victory');
    }
  };

  const updateLeaderboard = () => {
    const list = [
      { name: profile?.name || 'Vanguard', kills: playerRef.current.kills || 0, isPlayer: true },
      ...botsRef.current.map(b => ({ name: b.nickname, kills: b.kills || 0, isPlayer: false }))
    ].sort((a, b) => (b.kills || 0) - (a.kills || 0));
    
    setLeaderboard(list.slice(0, 5));
    leaderboardRef.current = list;
  };

  /**
   * NETWORK MODE tick: no local simulation — map the interpolated server
   * snapshot into the refs the existing draw() already renders, publish the
   * current input, and sync the HUD at ~10Hz. None of the local win/lose
   * rules run here, so the empty-world instant-victory bug cannot fire online.
   */
  const networkTick = (dt: number, time: number) => {
    const net = netRef.current;
    const player = playerRef.current;
    const view = net?.interpolate(time) ?? null;

    // ── Zone ruleset: whatever difficulty code the SERVER reports ──
    // Polled every frame (not just on `joined`) so event ordering cannot lose
    // it. Never falls back to 1 once known.
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

    if (view) {
      // ── SERVER-AUTHORITATIVE SAFE ZONE → the render refs ──
      // A mirror, NOT a simulation: updateZone() (the local sim) is never
      // reached online, so the ring we draw is exactly the ring the server
      // kills you against. Zone maths/units are identical to practice
      // (8000² world, same centre coordinates).
      const zone = view.zone;
      if (zone) {
        const z = zoneRef.current;
        z.x = zone.x;
        z.y = zone.y;
        z.radius = zone.radius;
        z.safeZone = { x: zone.x, y: zone.y, radius: zone.radius };
        z.nextSafeZone = zone.next ? { ...zone.next } : null;
        z.isShrinking = zone.shrinking;
        z.phase = zone.phase;
        z.phaseTimer = zone.phaseTimer;
        z.countdownTimer = zone.countdown;
        z.outsideTimer = zone.outsideTimer;
      }

      // Own ship pose comes from FreeplayNet's LOCAL PREDICTION: we integrate
      // our own turn/auto-drive at the server's measured constants and the
      // library reconciles against the authoritative position every frame.
      // That is what makes steering feel like practice instead of like a
      // 20Hz slideshow (and removes the snapshot jitter entirely).
      if (view.you) {
        player.x = view.you.x;
        player.y = view.you.y;
        player.angle = Number(view.you.angle ?? player.angle);
        player.kills = Number(view.you.kills ?? player.kills ?? 0);
        netKillsRef.current = player.kills ?? 0;
        netServerAmmoRef.current.magazine = Number(view.you.ammo ?? view.you.mag ?? view.you.magazine ?? 30);
        netServerAmmoRef.current.reloading = !!view.you.reloading;
      }

      // Remote players -> bot-shaped adapters for the existing draw code.
      const cache = netBotCacheRef.current;
      const seen = new Set<string>();
      botsRef.current = view.players.map((pl) => {
        seen.add(pl.id);
        let ship = cache.get(pl.id);
        if (!ship) {
          ship = { x: pl.x, y: pl.y, vx: 0, vy: 0, radius: 15, angle: 0, type: 'bot', id: pl.id };
          cache.set(pl.id, ship);
        }
        ship.x = pl.x;
        ship.y = pl.y;
        ship.angle = Number(pl.angle ?? 0);
        ship.nickname = pl.name ?? 'PILOT';
        ship.health = Number(pl.hp ?? pl.health ?? 100);
        return ship;
      });
      for (const id of Array.from(cache.keys())) {
        if (!seen.has(id)) cache.delete(id);
      }

      // Asteroids drift server-side; the spin is a purely cosmetic local touch.
      const aCache = netAsteroidCacheRef.current;
      const aSeen = new Set<string | number>();
      asteroidsRef.current = view.asteroids.map((a) => {
        const key = a.id ?? `${Math.round(a.x)}|${Math.round(a.y)}`; // idless fallback
        aSeen.add(key);
        let rock = aCache.get(key);
        if (!rock) {
          rock = {
            x: a.x, y: a.y, vx: 0, vy: 0,
            radius: 60,
            rotation: Math.random() * Math.PI * 2,
            rotationSpeed: (Math.random() - 0.5) * 0.05,
            subType: 'normal', color: '#ffffff',
          };
          aCache.set(key, rock);
        }
        rock.x = a.x;
        rock.y = a.y;
        rock.radius = Number(a.r ?? a.radius ?? rock.radius);
        rock.rotation = (rock.rotation || 0) + (rock.rotationSpeed || 0) * dt;
        return rock;
      });
      for (const key of Array.from(aCache.keys())) {
        if (!aSeen.has(key)) aCache.delete(key);
      }

      // Bullets: the streak heading comes from the lib's derived angle.
      bulletsRef.current = view.bullets.map((b) => ({
        x: b.x, y: b.y, vx: 0, vy: 0, radius: 3,
        type: 'bullet' as const,
        rotation: Number(b.angle ?? 0),
        color: '#00FFD1',
      }));
    }

    // ── Publish input (the FreeplayNet interval sends it at 20Hz) ──
    const keys = keysRef.current;
    const left = keys['a'] || keys['arrowleft'];
    const right = keys['d'] || keys['arrowright'];
    const turn = ((right ? 1 : 0) - (left ? 1 : 0)) as -1 | 0 | 1;
    const shoot = isShootingRef.current || !!keys[' '] || !!keys['space'];
    const reload = !!keys['r'] || isUiReloaderHeldRef.current || time < reloadPulseUntilRef.current;
    netInputRef.current = { turn, shoot, reload };
    net?.setInput({ ...netInputRef.current });

    // Local gun sound + muzzle flash at the practice fire rate (800 RPM =
    // 75ms, the same interval the server enforces) while we still have ammo.
    const nowMs = Date.now();
    if (shoot && nowMs - lastShootTimeRef.current >= SHOOT_INTERVAL &&
        netServerAmmoRef.current.magazine > 0 && !netServerAmmoRef.current.reloading) {
      triggerShot();
      lastShootTimeRef.current = nowMs;
      // Muzzle flash — identical to the practice shoot() burst.
      const muzzleX = player.x + Math.cos(player.angle) * 20;
      const muzzleY = player.y + Math.sin(player.angle) * 20;
      for (let i = 0; i < 3; i++) {
        particlesRef.current.push({
          x: muzzleX,
          y: muzzleY,
          vx: (Math.random() - 0.5) * 5,
          vy: (Math.random() - 0.5) * 5,
          radius: Math.random() * 2,
          lifetime: 20,
          color: '#FFFFFF',
          type: 'particle',
        });
      }
    }

    // Engine exhaust — the practice loop emits this every other frame, and
    // without it the online ship looked dead in the water.
    if (Math.random() > 0.5) {
      particlesRef.current.push({
        x: player.x - Math.cos(player.angle) * 15,
        y: player.y - Math.sin(player.angle) * 15,
        vx: -Math.cos(player.angle) * 3 + (Math.random() - 0.5) * 2,
        vy: -Math.sin(player.angle) * 3 + (Math.random() - 0.5) * 2,
        radius: Math.random() * 3,
        lifetime: 15,
        color: '#FF0080',
        type: 'particle',
      });
    }

    // Age particles exactly like the practice path (they are render-only).
    particlesRef.current = particlesRef.current.filter((p) => {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.lifetime !== undefined) {
        p.lifetime -= dt;
        return p.lifetime > 0;
      }
      return false;
    });

    // Camera follow + kill-based zoom (identical maths to the local path).
    const lerp = 0.1;
    cameraRef.current.x += (player.x - cameraRef.current.x) * lerp;
    cameraRef.current.y += ((player.y - dimensions.height * 0.15) - cameraRef.current.y) * lerp;
    const targetZoom = 1 / (1 + Math.min(netKillsRef.current, 10) * 0.1);
    currentZoomRef.current += (targetZoom - currentZoomRef.current) * 0.03 * dt;

    // Kill-feed / damage text lifetimes (same bookkeeping as the local path).
    damageIndicatorsRef.current = damageIndicatorsRef.current.map(di => ({ ...di, lifetime: di.lifetime - dt, y: di.y - 1.5 * dt })).filter(di => di.lifetime > 0);
    killNotificationsRef.current = killNotificationsRef.current.map(kn => ({ ...kn, lifetime: kn.lifetime - dt })).filter(kn => kn.lifetime > 0);
    hitmarkersRef.current = hitmarkersRef.current.filter(h => nowMs - h.time < 150);

    // Throttled HUD sync (~10Hz), mirroring the local pattern.
    if (nowMs - lastHudUpdateRef.current > 100) {
      lastHudUpdateRef.current = nowMs;
      setPlayerPos({ x: player.x, y: player.y });
      setKills(player.kills ?? 0);
      if (view?.you) {
        setHealth(Math.max(0, Math.round(Number(view.you.hp ?? view.you.health ?? 100))));
        setAmmo({
          magazine: netServerAmmoRef.current.magazine,
          reserve: 0, // the online world has no reserve pool (reload refills fully)
          reloading: netServerAmmoRef.current.reloading,
        });
      }
      if (view) {
        // Leaderboard: kills online (no pot any more — online has no money).
        const lb = view.leaderboard.map((l) => ({
          name: l.name,
          kills: l.kills || l.score || 0,
          isPlayer: !!profile?.name && l.name === profile.name,
        }));
        setLeaderboard(lb);
        leaderboardRef.current = lb;

        // Zone HUD (phase timer, shrink countdown, out-of-zone warning,
        // minimap ring) — the same React state the practice HUD renders,
        // fed from the server's authoritative zone.
        if (view.zone) {
          const z = zoneRef.current;
          // PRACTICE SEMANTICS: `outsideTimer` counts UP while you are outside
          // the ring and is 0 whenever you are inside — the HUD warning is
          // exactly `outsideTimer > 0`. Gating on the server's own ring vs the
          // server's own position keeps that identical online (and keeps the
          // warning silent in Eclipse/Blitz, which kill instantly).
          const outside = Math.hypot(player.x - z.x, player.y - z.y) > z.radius;
          setUiZone({
            radius: z.radius,
            x: z.x,
            y: z.y,
            outsideTimer: outside ? z.outsideTimer : 0,
            phaseTimer: z.phaseTimer,
            countdownTimer: z.countdownTimer,
          });
        }
      }
    }
  };

  const update = (time: number) => {
    if (!lastTimeRef.current) {
      lastTimeRef.current = time;
      requestRef.current = requestAnimationFrame(update);
      return;
    }

    const dt = (time - lastTimeRef.current) / (1000 / 60);
    lastTimeRef.current = time;

    if (gameState === 'playing' && isNetworkMode) {
      // ── NETWORK MODE: server-authoritative — skip ALL local simulation ──
      networkTick(dt, time);
      draw();
      requestRef.current = requestAnimationFrame(update);
      return;
    }

    if (gameState === 'playing') {
      const player = playerRef.current;

      // Ammo / Reload 1.5-Second Click Logic
      const isPressingReload = keysRef.current['r'] || isUiReloaderHeldRef.current;
      const canReload = player.magazine < 100 && player.reserve > 0;

      if (isPressingReload && canReload && player.reloadTimer <= 0) {
        player.reloadTimer = 1.5;
        triggerReload();
        setAmmo(a => ({ ...a, reloading: true }));
      }

      if (player.reloadTimer > 0) {
        player.reloadTimer -= dt / 60;
        const currentProgress = Math.max(0, Math.min(1, 1 - (player.reloadTimer / 1.5)));
        setReloadProgress(currentProgress);

        if (player.reloadTimer <= 0) {
          const needed = 100 - player.magazine;
          const toReload = Math.min(needed, player.reserve);
          player.magazine += toReload;
          player.reserve -= toReload;
          
          player.reloadTimer = 0;
          setReloadProgress(0);
          setAmmo({ magazine: player.magazine, reserve: player.reserve, reloading: false });
        }
      }

      if (keysRef.current['shift']) {
        if (player.boostReserve !== undefined && player.boostReserve > 0) {
          player.boostReserve -= dt / 60;
          setIsBoosting(true);
          if (player.boostReserve < 0) player.boostReserve = 0;
        } else {
          setIsBoosting(false);
        }
      } else {
        setIsBoosting(false);
      }
      setBoostReserveState(player.boostReserve || 0);

      updateZone(dt);
      updateBots(dt);
      updateLeaderboard();

      // Rotation
      if (keysRef.current['a'] || keysRef.current['arrowleft']) {
        player.angularVelocity -= player.rotationSpeed * dt;
      }
      if (keysRef.current['d'] || keysRef.current['arrowright']) {
        player.angularVelocity += player.rotationSpeed * dt;
      }
      // Clamp max spin speed
      player.angularVelocity = Math.max(-0.16, Math.min(0.16, player.angularVelocity));
      player.angle += player.angularVelocity * dt;
      player.angularVelocity *= player.angularFriction;

      // Acceleration (Auto-drive: always moving forward)
      let currentAcceleration = player.acceleration;
      if (keysRef.current['shift'] && player.boostReserve !== undefined && player.boostReserve > 0) {
        currentAcceleration *= 1.65;
      }
      player.vx += Math.cos(player.angle) * currentAcceleration * dt;
      player.vy += Math.sin(player.angle) * currentAcceleration * dt;

      // Auto-realignment logic (North/South) when not actively turning
      const isTurning = keysRef.current['a'] || keysRef.current['arrowleft'] || keysRef.current['d'] || keysRef.current['arrowright'];
      if (!isTurning) {
        // Normalize angle to [-PI, PI] for easier comparison
        let normAngle = player.angle % (Math.PI * 2);
        if (normAngle > Math.PI) normAngle -= Math.PI * 2;
        if (normAngle < -Math.PI) normAngle += Math.PI * 2;

        // Target angles: North (-PI/2) or South (PI/2)
        const targetNorth = -Math.PI / 2;
        const targetSouth = Math.PI / 2;
        
        // Find closest target
        const distToNorth = Math.abs(normAngle - targetNorth);
        const distToSouth = Math.abs(normAngle - targetSouth);
        
        let target = distToNorth < distToSouth ? targetNorth : targetSouth;

        // Apply a gentle rotational pull towards the target
        let angleDiff = target - normAngle;
        // Wrap difference to shortest path
        if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

        // Only realign if we're somewhat close to vertical (to allow drifting slightly sideways without snapping too hard)
        // But the prompt says "automatically relign their jet", so we apply it whenever not turning.
        player.angularVelocity += angleDiff * 0.003 * dt;
      }
      
      // Thrust particles
      const isPlayerBoosting = keysRef.current['shift'] && player.boostReserve !== undefined && player.boostReserve > 0;
      if (isPlayerBoosting) {
          particlesRef.current.push({
              x: player.x,
              y: player.y,
              vx: 0,
              vy: 0,
              radius: 15,
              angle: player.angle,
              lifetime: 15,
              maxLifetime: 15,
              color: '#00FFD1',
              type: 'trail'
          });
      } else if (Math.random() > 0.5) {
          particlesRef.current.push({
              x: player.x - Math.cos(player.angle) * 15,
              y: player.y - Math.sin(player.angle) * 15,
              vx: -Math.cos(player.angle) * 3 + (Math.random() - 0.5) * 2,
              vy: -Math.sin(player.angle) * 3 + (Math.random() - 0.5) * 2,
              radius: Math.random() * 3,
              lifetime: 15,
              color: '#FF0080',
              type: 'particle'
          });
      }

      // Physics
      player.x += player.vx * dt;
      player.y += player.vy * dt;
      player.vx *= player.friction;
      player.vy *= player.friction;

      // Barrier Logic for Player (Instead of Wrap)
      if (player.x < player.radius) { player.x = player.radius; player.vx *= -0.5; }
      if (player.x > WORLD_SIZE - player.radius) { player.x = WORLD_SIZE - player.radius; player.vx *= -0.5; }
      if (player.y < player.radius) { player.y = player.radius; player.vy *= -0.5; }
      if (player.y > WORLD_SIZE - player.radius) { player.y = WORLD_SIZE - player.radius; player.vy *= -0.5; }

      // Throttled HUD Update (10 fps approx) to save DOM reconciliations
      const nowMs = Date.now();
      if (nowMs - lastHudUpdateRef.current > 100) {
        lastHudUpdateRef.current = nowMs;
        setPlayerPos({ x: player.x, y: player.y });
      }

      // Update Damage Indicators and Kill Notifications manually
      damageIndicatorsRef.current = damageIndicatorsRef.current.map(di => ({ ...di, lifetime: di.lifetime - dt, y: di.y - 1.5 * dt })).filter(di => di.lifetime > 0);
      killNotificationsRef.current = killNotificationsRef.current.map(kn => ({ ...kn, lifetime: kn.lifetime - dt })).filter(kn => kn.lifetime > 0);
      hitmarkersRef.current = hitmarkersRef.current.filter(h => nowMs - h.time < 150);

      // Update camera (Smooth follow)
      const lerp = 0.1;
      // Position player lower on the screen (y-offset of 15% of height)
      const targetCamX = player.x;
      const targetCamY = player.y - dimensions.height * 0.15;
      
      cameraRef.current.x += (targetCamX - cameraRef.current.x) * lerp;
      cameraRef.current.y += (targetCamY - cameraRef.current.y) * lerp;

      // Smooth Zoom / FOV based on kills
      const targetZoom = 1 / (1 + Math.min(kills, 10) * 0.1); // Slightly wider expand
      currentZoomRef.current += (targetZoom - currentZoomRef.current) * 0.03 * dt;

      // Automatic Shooting Logic
      const now = Date.now();
      if ((isShootingRef.current || keysRef.current[' '] || keysRef.current['space']) && now - lastShootTimeRef.current >= SHOOT_INTERVAL) {
          if (player.magazine > 0 && (player.reloadTimer || 0) <= 0) {
              shoot();
              lastShootTimeRef.current = now;
          }
      }

      // Hit timer
      if (player.hitTimer > 0) {
        player.hitTimer -= dt;
        if (player.hitTimer <= 0) {
          player.isHit = false;
        }
      }

      // Update bullets
      bulletsRef.current = bulletsRef.current.filter(b => {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        return b.x > 0 && b.x < WORLD_SIZE && b.y > 0 && b.y < WORLD_SIZE;
      });

      // Update asteroids
      asteroidsRef.current.forEach(a => {
        a.x += a.vx * dt;
        a.y += a.vy * dt;
        a.rotation = (a.rotation || 0) + (a.rotationSpeed || 0) * dt;

        // Bounce asteroids off world boundaries
        if (a.x < a.radius) { a.x = a.radius; a.vx *= -1; }
        if (a.x > WORLD_SIZE - a.radius) { a.x = WORLD_SIZE - a.radius; a.vx *= -1; }
        if (a.y < a.radius) { a.y = a.radius; a.vy *= -1; }
        if (a.y > WORLD_SIZE - a.radius) { a.y = WORLD_SIZE - a.radius; a.vy *= -1; }
      });

      // Spawn asteroids near player but outside screen
      spawnTimerRef.current -= dt;
      if (spawnTimerRef.current <= 0) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.max(dimensions.width, dimensions.height) * (1.2 + Math.random() * 1.5);
        const x = player.x + Math.cos(angle) * dist;
        const y = player.y + Math.sin(angle) * dist;
        const size = 20 + Math.random() * 40;

        const targetX = player.x;
        const targetY = player.y;
        const moveAngle = Math.atan2(targetY - y, targetX - x) + (Math.random() - 0.5) * 0.5;
        const speed = 1.5 + Math.random() * 2;

        const { subType, color } = getNextAsteroidTypeAndColor();

        asteroidsRef.current.push({
          x, y,
          vx: Math.cos(moveAngle) * speed,
          vy: Math.sin(moveAngle) * speed,
          radius: size,
          rotation: Math.random() * Math.PI * 2,
          rotationSpeed: (Math.random() - 0.5) * 0.05,
          color,
          subType
        });
        spawnTimerRef.current = Math.max(20, 120 - score / 250);
      }

      // Collisions: Bullet vs Asteroid
      bulletsRef.current.forEach((bullet, bIndex) => {
        asteroidsRef.current.forEach((asteroid, aIndex) => {
            const dx = bullet.x - asteroid.x;
            const dy = bullet.y - asteroid.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < bullet.radius + asteroid.radius) {
                if (!bullet.id) {
                    playHitmarker();
                    hitmarkersRef.current.push({ id: Math.random().toString(), time: Date.now(), x: bullet.x, y: bullet.y });
                }
                // Remove bullet and asteroid
                bulletsRef.current.splice(bIndex, 1);
                
                // Explode and potentially split
                createExplosion(asteroid.x, asteroid.y, asteroid.color || '#00FFD1');
                
                // Powerup application for the bullet owner
                if (asteroid.subType === 'health') {
                    if (!bullet.id) {
                        setHealth(h => Math.min(100, h + 20));
                    } else {
                        const bot = botsRef.current.find(b => b.id === bullet.id);
                        if (bot) {
                            bot.health = Math.min(100, (bot.health || 0) + 20);
                        }
                    }
                } else if (asteroid.subType === 'ammo') {
                    if (!bullet.id) {
                        setAmmo(a => ({ ...a, reserve: Math.min(120, a.reserve + 10) }));
                        playerRef.current.reserve += 10;
                    } else {
                        const bot = botsRef.current.find(b => b.id === bullet.id);
                        if (bot && bot.reserve !== undefined) {
                            bot.reserve += 10;
                        }
                    }
                }

                if (asteroid.radius > 20) {
                    // Split into two smaller ones
                    for(let i=0; i<2; i++) {
                        asteroidsRef.current.push({
                            x: asteroid.x,
                            y: asteroid.y,
                            vx: (Math.random() - 0.5) * 5,
                            vy: (Math.random() - 0.5) * 5,
                            radius: asteroid.radius / 2,
                            rotation: Math.random() * Math.PI * 2,
                            rotationSpeed: (Math.random() - 0.5) * 0.1,
                            color: asteroid.color,
                            subType: asteroid.subType
                        });
                    }
                }

                asteroidsRef.current.splice(aIndex, 1);
                setScore(s => s + 100);
            }
        });
      });

      // Collisions: Bullet vs Bot
      bulletsRef.current.forEach((bullet, bIndex) => {
        botsRef.current.forEach((bot, botIndex) => {
          if (bullet.id === bot.id) return; // Don't hit self

          const dx = bullet.x - bot.x;
          const dy = bullet.y - bot.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < bullet.radius + bot.radius) {
            bulletsRef.current.splice(bIndex, 1);
            
            // Damage Logic
            let damage = 20;
            let isBackstab = false;

            // Check for backstab: bullet direction roughly matches bot direction
            // Bullet velocity angle
            const bulletAngle = Math.atan2(bullet.vy, bullet.vx);
            const botFacing = bot.angle || 0;
            let angleDiff = Math.abs(bulletAngle - botFacing);
            while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
            angleDiff = Math.abs(angleDiff);

            // If angle difference is small, it hit from behind (same direction)
            if (angleDiff < 0.6) {
              damage = 50;
              isBackstab = true;
              if (!bullet.id) playCritHit();
            }

            bot.health = (bot.health || 0) - damage;
            createExplosion(bot.x, bot.y, '#FF0080', 5);
            
            // Show damage indicator
            damageIndicatorsRef.current.push({
                id: Math.random().toString(),
                x: bot.x,
                y: bot.y - 20,
                value: damage,
                lifetime: 60
            });
            
            if (bot.health <= 0) {
              createExplosion(bot.x, bot.y, '#FF0080', 20);
              const nickname = bot.nickname || 'Unknown';
              botsRef.current.splice(botIndex, 1);
              
              if (!bullet.id) {
                playKillSound();
                setScore(s => s + 500); // Player gets score
                setHealth(h => Math.min(100, h + 20));
                playerRef.current.reserve = (playerRef.current.reserve || 0) + 30;
                playerRef.current.boostReserve = (playerRef.current.boostReserve || 0) + 5;
                setAmmo(a => ({ ...a, reserve: playerRef.current.reserve }));
                setKills(k => {
                   const newKills = k + 1;
                   if (newKills === 5) {
                     setStreakNotification({ text: 'BLOOD THIRSTY', icon: <Flame className="w-8 h-8 text-orange-500" />, id: Date.now() });
                     playKillstreakSound();
                   } else if (newKills === 10) {
                     setStreakNotification({ text: 'MERCILESS', icon: <Zap className="w-8 h-8 text-yellow-400" />, id: Date.now() });
                     playKillstreakSound();
                   } else if (newKills === 15) {
                     setStreakNotification({ text: 'SLAYER', icon: <Sword className="w-8 h-8 text-purple-500" />, id: Date.now() });
                     playKillstreakSound();
                   } else if (newKills === 25) {
                     setStreakNotification({ text: 'JUGGERNAUT', icon: <ShieldAlert className="w-8 h-8 text-red-600" />, id: Date.now() });
                     playKillstreakSound();
                   } else if (newKills === 30) {
                     setStreakNotification({ text: 'NUKE', icon: <Radiation className="w-8 h-8 text-green-500" />, id: Date.now() });
                     playKillstreakSound();
                     nukeTriggeredRef.current = true;
                   }
                   return newKills;
                });
                playerRef.current.kills = (playerRef.current.kills || 0) + 1;
                killNotificationsRef.current.push({
                    id: Math.random().toString(),
                    nickname: nickname,
                    lifetime: 90
                });
              } else {
                // Bot got the kill
                const shooter = botsRef.current.find(b => b.id === bullet.id);
                if (shooter) shooter.kills = (shooter.kills || 0) + 1;
              }
            }
          }
        });

        // Bullet vs Player
        if (bullet.id) {
          const dx = bullet.x - player.x;
          const dy = bullet.y - player.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < bullet.radius + player.radius && !player.isHit) {
            bulletsRef.current.splice(bIndex, 1);
            player.isHit = true;
            player.hitTimer = 30;
            
            const damage = 20;
            setHealth(h => {
              const nextH = Math.max(0, h - damage);
              if (nextH <= 0) setGameState('gameover');
              return nextH;
            });
            
            damageIndicatorsRef.current.push({
                id: Math.random().toString(),
                x: player.x,
                y: player.y - 20,
                value: damage,
                lifetime: 60
            });
            
            createExplosion(player.x, player.y, '#00FFD1', 10);
          }
        }
      });

      // Collisions: Asteroid vs Player or Bot
      asteroidsRef.current.forEach((asteroid, aIndex) => {
        // Player check
        const dxP = playerRef.current.x - asteroid.x;
        const dyP = playerRef.current.y - asteroid.y;
        const distP = Math.sqrt(dxP * dxP + dyP * dyP);

        if (distP < playerRef.current.radius + asteroid.radius && !playerRef.current.isHit) {
            playerRef.current.isHit = true;
            playerRef.current.hitTimer = 60;
            setHealth(0); // Instant Kill
            setGameState('gameover');
            createExplosion(playerRef.current.x, playerRef.current.y, '#FF0080', 50);
            asteroidsRef.current.splice(aIndex, 1);
            return;
        }

        // Bot check
        botsRef.current.forEach((bot, botIndex) => {
          const dx = asteroid.x - bot.x;
          const dy = asteroid.y - bot.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < asteroid.radius + bot.radius) {
            createExplosion(bot.x, bot.y, '#FF0080', 30);
            botsRef.current.splice(botIndex, 1);
            asteroidsRef.current.splice(aIndex, 1);
          }
        });
      });
    }

    // Update particles
    particlesRef.current = particlesRef.current.filter(p => {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.lifetime !== undefined) {
            p.lifetime -= dt;
            return p.lifetime > 0;
        }
        return false;
    });

    // Handle Nuke
    if (nukeTriggeredRef.current) {
        botsRef.current.forEach(bot => {
            createExplosion(bot.x, bot.y, '#FFFFFF', 30);
        });
        botsRef.current = [];
        nukeTriggeredRef.current = false;
    }

    // These local win conditions must NEVER fire in network mode: an empty
    // botsRef (no bots online) or a client-side kill counter would otherwise
    // declare an instant, unearned victory. Server events end online sessions.
    if (!isNetworkMode && wagerMode === 'free_play' && targetKills !== undefined && playerRef.current.kills >= targetKills && gameState === 'playing') {
       setGameState('victory');
    } else if (!isNetworkMode && (wagerMode === 'slayer' || wagerMode === 'lms') && botsRef.current.length === 0 && gameState === 'playing') {
       setGameState('victory');
    }

    draw();
    requestRef.current = requestAnimationFrame(update);
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, dimensions.width, dimensions.height);

    // Dynamic FOV / Zoom based on kills - zoom out (expand FOV) as you get kills
    const zoomLevel = currentZoomRef.current;
    
    ctx.save();
    // Translate to center, scale around center, then translate back
    ctx.translate(dimensions.width / 2, dimensions.height / 2);
    ctx.scale(zoomLevel, zoomLevel);
    ctx.translate(-dimensions.width / 2, -dimensions.height / 2);

    const camX = cameraRef.current.x - dimensions.width / 2;
    const camY = cameraRef.current.y - dimensions.height / 2;

    // Draw World Boundary
    ctx.strokeStyle = 'rgba(0, 255, 209, 0.2)';
    ctx.lineWidth = 4;
    ctx.strokeRect(-camX, -camY, WORLD_SIZE, WORLD_SIZE);
    
    // Draw grid
    ctx.strokeStyle = 'rgba(0, 255, 209, 0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= WORLD_SIZE; x += 500) {
      ctx.beginPath(); ctx.moveTo(x - camX, -camY); ctx.lineTo(x - camX, WORLD_SIZE - camY); ctx.stroke();
    }
    for (let y = 0; y <= WORLD_SIZE; y += 500) {
      ctx.beginPath(); ctx.moveTo(-camX, y - camY); ctx.lineTo(WORLD_SIZE - camX, y - camY); ctx.stroke();
    }

    // Draw Zone.
    // ONLINE the gate is the SERVER's difficulty code (read through the ref so
    // a mid-session ruleset stamp reaches this already-captured closure);
    // practice reads its own prop exactly as before.
    const drawZoneDifficulty = zoneDifficulty();
    if (drawZoneDifficulty !== 1 && drawZoneDifficulty !== 2 && drawZoneDifficulty !== 3) {
      const zx = zoneRef.current.x - camX;
      const zy = zoneRef.current.y - camY;
      
      // Draw Next Safe Zone Target (Visual Guide)
      if (zoneRef.current.nextSafeZone) {
        const nzx = zoneRef.current.nextSafeZone.x - camX;
        const nzy = zoneRef.current.nextSafeZone.y - camY;
        ctx.save();
        ctx.strokeStyle = '#00FFD1';
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 10]);
        ctx.globalAlpha = 0.3 + Math.sin(Date.now() / 400) * 0.1;
        ctx.beginPath();
        ctx.arc(nzx, nzy, zoneRef.current.nextSafeZone.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Outer barrier glow
      ctx.save();
      ctx.strokeStyle = '#FF0080';
      ctx.lineWidth = 10;
      ctx.globalAlpha = 0.2 + Math.sin(Date.now() / 200) * 0.1;
      ctx.beginPath();
      ctx.arc(zx, zy, zoneRef.current.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1.0;
      
      // Scanner line
      ctx.strokeStyle = '#FF0080';
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 10]);
      ctx.beginPath();
      ctx.arc(zx, zy, zoneRef.current.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Draw background stars
    starsRef.current.forEach(star => {
        // Draw stars with parallax or world-relative
        // For simplicity, we draw them in world space
        const sx = star.x - camX;
        const sy = star.y - camY;

        // Skip if outside screen
        if (sx < -50 || sx > dimensions.width + 50 || sy < -50 || sy > dimensions.height + 50) return;

        const twinkle = Math.sin(Date.now() / 1000 + star.x) * 0.2;
        ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity + twinkle})`;
        ctx.beginPath();
        ctx.arc(sx, sy, star.size, 0, Math.PI * 2);
        ctx.fill();

        if (star.size > 1.5) {
            ctx.shadowColor = 'white';
            ctx.shadowBlur = 10;
            ctx.stroke();
            ctx.shadowBlur = 0;
        }
    });

    // Draw particles
    particlesRef.current.forEach(p => {
        const sx = p.x - camX;
        const sy = p.y - camY;
        if (sx < -50 || sx > dimensions.width + 50 || sy < -50 || sy > dimensions.height + 50) return;

        if (p.type === 'trail') {
            ctx.save();
            ctx.translate(sx, sy);
            ctx.scale(1 / currentZoomRef.current, 1 / currentZoomRef.current);
            ctx.rotate(p.angle || 0);
            ctx.globalAlpha = (p.lifetime || 15) / (p.maxLifetime || 15) * 0.4;
            ctx.shadowColor = '#00FFD1';
            ctx.shadowBlur = 15;
            ctx.fillStyle = '#00FFD1';
            ctx.beginPath();
            ctx.moveTo(14, 0);
            ctx.lineTo(-4, -30);
            ctx.lineTo(-16, -30);
            ctx.lineTo(-9, -18);
            ctx.lineTo(-19, -8);
            ctx.lineTo(-21, 0);
            ctx.lineTo(-19, 8);
            ctx.lineTo(-9, 18);
            ctx.lineTo(-16, 30);
            ctx.lineTo(-4, 30);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        } else {
            ctx.globalAlpha = (p.lifetime || 20) / 40;
            ctx.fillStyle = p.color || '#fff';
            ctx.beginPath();
            ctx.arc(sx, sy, p.radius, 0, Math.PI * 2);
            ctx.fill();
        }
    });
    ctx.globalAlpha = 1.0;

    // Draw Asteroids
    asteroidsRef.current.forEach(a => {
        const sx = a.x - camX;
        const sy = a.y - camY;
        if (sx < -a.radius || sx > dimensions.width + a.radius || sy < -a.radius || sy > dimensions.height + a.radius) return;

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(a.rotation || 0);
        
        let shadowColor = 'rgba(0, 255, 209, 0.3)';
        let strokeStyle = '#fff';

        if (a.subType === 'health') {
          shadowColor = 'rgba(0, 255, 68, 0.45)';
          strokeStyle = '#00ff44';
        } else if (a.subType === 'ammo') {
          shadowColor = 'rgba(0, 170, 255, 0.45)';
          strokeStyle = '#00aaff';
        }

        ctx.shadowColor = shadowColor;
        ctx.shadowBlur = 15;
        
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = 2;
        ctx.beginPath();
        
        const points = 8;
        for (let i = 0; i < points; i++) {
            const angle = (i / points) * Math.PI * 2;
            const r = a.radius * (0.8 + Math.random() * 0.2);
            const px = Math.cos(angle) * r;
            const py = Math.sin(angle) * r;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
        
        ctx.restore();
    });

    // Draw Bots
    botsRef.current.forEach(bot => {
        const sx = bot.x - camX;
        const sy = bot.y - camY;
        if (sx < -60 || sx > dimensions.width + 60 || sy < -60 || sy > dimensions.height + 60) return;

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(bot.angle || 0);
        
        ctx.shadowColor = '#FF0080';
        ctx.shadowBlur = 15;
        ctx.strokeStyle = '#FF0080';
        ctx.fillStyle = 'rgba(255, 0, 128, 0.08)';
        ctx.lineWidth = 2;

        // B-2 Spirit flying-wing silhouette (Hostile Pink Version)
        ctx.beginPath();
        ctx.moveTo(14, 0);          // nose
        ctx.lineTo(-4, -30);        // left leading edge → tip
        ctx.lineTo(-16, -30);       // left tip trailing corner
        ctx.lineTo(-9, -18);        // left W notch outer
        ctx.lineTo(-19, -8);        // left W notch inner
        ctx.lineTo(-21, 0);         // center trailing
        ctx.lineTo(-19, 8);         // right W notch inner
        ctx.lineTo(-9, 18);         // right W notch outer
        ctx.lineTo(-16, 30);        // right tip trailing corner
        ctx.lineTo(-4, 30);         // right leading edge ← tip
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Panel lines
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(12, 0);
        ctx.lineTo(-20, 0);
        ctx.stroke();
        ctx.globalAlpha = 1.0;

        // Cockpit
        ctx.fillStyle = 'rgba(255,0,128,0.4)';
        ctx.beginPath();
        ctx.ellipse(8, 0, 5, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();

        // Bot Nickname
        ctx.fillStyle = 'rgba(255, 0, 128, 0.8)';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(bot.nickname || '', sx, sy - 35);
    });

    // Draw Bullets
    bulletsRef.current.forEach(b => {
        const sx = b.x - camX;
        const sy = b.y - camY;
        if (sx < -20 || sx > dimensions.width + 20 || sy < -20 || sy > dimensions.height + 20) return;

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(b.rotation);
        
        // Outer Glow/Tail
        ctx.shadowColor = '#00FFD1';
        ctx.shadowBlur = 15;
        ctx.strokeStyle = '#00FFD1';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.8;
        
        ctx.beginPath();
        ctx.moveTo(4, 0);
        ctx.lineTo(-12, 0); // Length of the bullet streak along X-axis
        ctx.stroke();
        
        // Inner Core (sharp)
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#FFF';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.moveTo(2, 0);
        ctx.lineTo(-8, 0);
        ctx.stroke();
        
        ctx.restore();
    });

    // Draw Player
    if (gameState !== 'gameover') {
        const p = playerRef.current;
        const sx = p.x - camX;
        const sy = p.y - camY;
        const currentZoom = currentZoomRef.current;

        ctx.save();
        ctx.translate(sx, sy);
        // Inverse the world zoom to keep ship size absolutely constant on screen
        ctx.scale(1 / currentZoom, 1 / currentZoom);
        ctx.rotate(p.angle);
        
        // Glow / hit flash
        if (p.isHit) {
          ctx.shadowColor = '#FF0080';
          ctx.shadowBlur = 25;
          ctx.strokeStyle = Math.floor(Date.now() / 100) % 2 === 0 ? '#FF0080' : '#fff';
          ctx.fillStyle = 'rgba(255, 0, 128, 0.12)';
        } else {
          ctx.shadowColor = '#00FFD1';
          ctx.shadowBlur = 18;
          ctx.strokeStyle = '#00FFD1';
          ctx.fillStyle = 'rgba(0, 255, 209, 0.08)';
        }

        ctx.lineWidth = 2;

        // ── B-2 Spirit flying-wing silhouette (top-down, facing +x) ──
        ctx.beginPath();
        ctx.moveTo(14, 0);          // nose
        ctx.lineTo(-4, -30);        // left leading edge → tip
        ctx.lineTo(-16, -30);       // left tip trailing corner
        ctx.lineTo(-9, -18);        // left W notch outer
        ctx.lineTo(-19, -8);        // left W notch inner
        ctx.lineTo(-21, 0);         // center trailing
        ctx.lineTo(-19, 8);         // right W notch inner
        ctx.lineTo(-9, 18);         // right W notch outer
        ctx.lineTo(-16, 30);        // right tip trailing corner
        ctx.lineTo(-4, 30);         // right leading edge ← tip
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Panel lines (subtle internal structure)
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;

        // Center spine
        ctx.beginPath();
        ctx.moveTo(12, 0);
        ctx.lineTo(-20, 0);
        ctx.stroke();

        // Left panel line
        ctx.beginPath();
        ctx.moveTo(2, -6);
        ctx.lineTo(-14, -20);
        ctx.stroke();

        // Right panel line
        ctx.beginPath();
        ctx.moveTo(2, 6);
        ctx.lineTo(-14, 20);
        ctx.stroke();

        ctx.globalAlpha = 1.0;

        // Cockpit blister
        ctx.fillStyle = p.isHit ? 'rgba(255,0,128,0.4)' : 'rgba(0,255,209,0.35)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.ellipse(8, 0, 5, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Engine glow on trailing edge (left + right)
        [-11, 11].forEach(ey => {
          ctx.fillStyle = p.isHit ? 'rgba(255,0,128,0.6)' : 'rgba(0,255,209,0.5)';
          ctx.shadowColor = p.isHit ? '#FF0080' : '#00FFD1';
          ctx.shadowBlur = 12;
          ctx.beginPath();
          ctx.ellipse(-17, ey, 2, 1.5, 0, 0, Math.PI * 2);
          ctx.fill();
        });

        ctx.restore();

        // New Ammo & Reload Indicator (bottom right of jet)
        const timeSinceLastShot = Date.now() - lastShootTimeRef.current;
        const reloadProg = p.reloadTimer > 0 ? Math.max(0, Math.min(1, 1 - (p.reloadTimer / 1.5))) : 0;
        const isReloading = p.reloadTimer > 0;
        
        let indicatorOpacity = 1;
        if (!isReloading && timeSinceLastShot > 3000) {
            indicatorOpacity = Math.max(0, 1 - (timeSinceLastShot - 3000) / 500);
        }

        if (indicatorOpacity > 0 || isReloading) {
            ctx.save();
            ctx.translate(sx + 50, sy + 50);
            ctx.scale(1 / currentZoom, 1 / currentZoom); // non-zoomed constant screen size
            ctx.globalAlpha = isReloading ? 1 : indicatorOpacity;

            const radius = 25;
            const tickLength = 10;
            
            if (isReloading) {
                // Background Track (Quarter Circle, PI/2 to 0)
                ctx.beginPath();
                ctx.arc(0, 0, radius + tickLength/2, Math.PI / 2, 0, true);
                ctx.strokeStyle = 'rgba(0, 255, 209, 0.15)';
                ctx.lineWidth = tickLength;
                ctx.stroke();

                // Foreground Solid Arc extending from left (Math.PI/2) to right (0)
                const startAngle = Math.PI / 2;
                const currentAngle = startAngle - (Math.PI / 2) * reloadProg;
                
                ctx.beginPath();
                ctx.arc(0, 0, radius + tickLength/2, startAngle, currentAngle, true);
                ctx.strokeStyle = '#00FFD1';
                ctx.shadowColor = '#00FFD1';
                ctx.shadowBlur = 10;
                ctx.lineWidth = tickLength;
                ctx.stroke();
                
                // Text
                ctx.fillStyle = '#00FFD1';
                ctx.font = '900 9px var(--font-body)';
                ctx.shadowBlur = 0;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText("RELOADING", 0, radius + 20);
            } else {
                // 100 individual little lines
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = '#00FFD1';
                ctx.shadowColor = '#00FFD1';
                ctx.shadowBlur = ((timeSinceLastShot < 100) ? 5 : 2);
                
                const mag = p.magazine || 0;
                ctx.beginPath();
                for (let i = 0; i < mag; i++) {
                    const angle = (Math.PI / 2) - (i / 99) * (Math.PI / 2); 
                    const cosA = Math.cos(angle);
                    const sinA = Math.sin(angle);
                    ctx.moveTo(cosA * radius, sinA * radius);
                    ctx.lineTo(cosA * (radius + tickLength), sinA * (radius + tickLength));
                }
                ctx.stroke();
                
                if (mag < 100) {
                   ctx.beginPath();
                   ctx.strokeStyle = 'rgba(0, 255, 209, 0.15)';
                   ctx.shadowBlur = 0;
                   for (let i = mag; i < 100; i++) {
                       const angle = (Math.PI / 2) - (i / 99) * (Math.PI / 2);
                       const cosA = Math.cos(angle);
                       const sinA = Math.sin(angle);
                       ctx.moveTo(cosA * radius, sinA * radius);
                       ctx.lineTo(cosA * (radius + tickLength), sinA * (radius + tickLength));
                   }
                   ctx.stroke();
                }
            }
            ctx.restore();
        }
    }

    // Draw Hitmarkers
    hitmarkersRef.current.forEach(hm => {
        const sx = hm.x - camX;
        const sy = hm.y - camY;
        ctx.save();
        ctx.translate(sx - 15, sy - 15);
        ctx.scale(0.3, 0.3); // SVG was 100x100 mapped to 30x30
        ctx.fillStyle = '#FF0000';
        ctx.shadowColor = 'rgba(255,0,0,0.9)';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(50, 42);
        ctx.lineTo(42, 22);
        ctx.lineTo(50, 2);
        ctx.lineTo(58, 22);
        ctx.closePath();
        ctx.moveTo(56, 48);
        ctx.lineTo(88, 58);
        ctx.lineTo(98, 88);
        ctx.lineTo(72, 82);
        ctx.closePath();
        ctx.moveTo(44, 48);
        ctx.lineTo(12, 58);
        ctx.lineTo(2, 88);
        ctx.lineTo(28, 82);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    });

    // Draw Damage Indicators
    damageIndicatorsRef.current.forEach(di => {
        const sx = di.x - camX;
        const sy = di.y - camY;
        ctx.save();
        ctx.fillStyle = `rgba(239, 68, 68, ${Math.max(0, di.lifetime / 60)})`;
        ctx.font = 'bold 20px sans-serif';
        ctx.shadowColor = 'rgba(255,0,0,0.8)';
        ctx.shadowBlur = 5;
        ctx.textAlign = 'center';
        ctx.fillText(`-${di.value}`, sx, sy);
        ctx.restore();
    });

    // Draw Kill Notifications
    killNotificationsRef.current.forEach((kn, idx) => {
        const sx = playerRef.current.x - camX + 40;
        const sy = playerRef.current.y - camY - 40 - (idx * 20);
        ctx.save();
        ctx.font = 'italic 900 16px sans-serif';
        ctx.textAlign = 'left';
        
        const alpha = Math.max(0, kn.lifetime / 90);
        ctx.fillStyle = `rgba(239, 68, 68, ${alpha})`;
        ctx.fillText('KILLED', sx, sy);
        const w = ctx.measureText('KILLED ').width;
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.fillText(kn.nickname, sx + w, sy);
        ctx.restore();
    });

    ctx.restore(); // End zoom scale
  };

  useEffect(() => {
    requestRef.current = requestAnimationFrame(update);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [gameState, dimensions]);

  /**
   * ONLINE: enter the world for the mode the lobby picked.
   *   free_play      → joins the permanent world immediately (no queue UI)
   *   slayer / lms  → enters matchmaking; the SEARCHING FOR ONLINE MATCH
   *                     overlay shows until the server starts the match
   * NOTHING here touches NeonBucks — online has no stake and no pot.
   */
  const startNetworkGame = () => {
    if (!onlineMode) return;
    setNetError(null);
    setNetJoined(false);
    setSessionWinnings(0);
    setRespawnInfo(null);
    setScore(0);
    setKills(0);
    setHealth(100);
    netKillsRef.current = 0;

    // OPTIMISTIC searching state — set on entry, NOT on a server ack. A
    // dropped/absent ack can no longer freeze the UI on the lobby.
    setNetSearching(onlineMode !== 'free_play');
    setNetQueue({ current: 1, needed: 2 });
    setNetMatch(null);
    setNetResult(null);
    setNetEliminated(false);
    netBotCacheRef.current.clear();
    netAsteroidCacheRef.current.clear();
    netServerAmmoRef.current = { magazine: 30, reloading: false };

    // A fresh session knows no ruleset until the server stamps one — and the
    // zone refs must not carry a previous match's ring into the new one.
    netDifficultyRef.current = FREE_PLAY_DIFFICULTY;
    setNetDifficulty(FREE_PLAY_DIFFICULTY);
    netHasZoneRef.current = false;
    setNetHasZone(false);
    zoneRef.current = {
      radius: WORLD_SIZE,
      x: WORLD_SIZE / 2,
      y: WORLD_SIZE / 2,
      safeZone: { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, radius: WORLD_SIZE },
      nextSafeZone: null,
      isShrinking: false,
      phaseTimer: 0,
      phase: 1,
      outsideTimer: 0,
      countdownTimer: null,
    };
    setUiZone({
      radius: WORLD_SIZE,
      x: WORLD_SIZE / 2,
      y: WORLD_SIZE / 2,
      outsideTimer: 0,
      phaseTimer: 0,
      countdownTimer: null,
    });

    // Neutral local shells — every gameplay value is overwritten by snapshots.
    playerRef.current = {
      x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, vx: 0, vy: 0,
      angle: -Math.PI / 2, angularVelocity: 0, radius: 15,
      rotationSpeed: 0.008, angularFriction: 0.88, acceleration: 0.2, friction: 0.98,
      isHit: false, hitTimer: 0, kills: 0,
      magazine: 30, reserve: 0, reloadTimer: 0, boostReserve: 0,
    };
    setAmmo({ magazine: 30, reserve: 0, reloading: false });
    setReloadProgress(0);
    setPlayerPos({ x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 });
    cameraRef.current = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
    currentZoomRef.current = 1;
    bulletsRef.current = [];
    asteroidsRef.current = [];
    botsRef.current = [];
    particlesRef.current = [];
    damageIndicatorsRef.current = [];
    killNotificationsRef.current = [];
    hitmarkersRef.current = [];
    setLeaderboard([]);
    leaderboardRef.current = [];

    netRef.current?.dispose(); // safety: never stack two sessions
    // The SECTOR is half of the server's difficulty code (eclipse→10/11,
    // blitz→12/13), so it has to travel with the queue request.
    const net = new FreeplayNet('asteroids', onlineMode, onlineSector);
    netRef.current = net;
    net.join({
      onQueue: ({ current, needed }) => setNetQueue({ current, needed }),
      onJoined: (info) => {
        // The zone ruleset the server is actually simulating.
        if (typeof info.difficulty === 'number') {
          netDifficultyRef.current = info.difficulty;
          setNetDifficulty(info.difficulty);
        }
        setNetSearching(false);
        setNetJoined(true);
      },
      onKill: ({ victimName }) => {
        // Reuse the existing canvas kill feed + audio.
        killNotificationsRef.current.push({ id: Math.random().toString(), nickname: victimName, lifetime: 90 });
        playKillSound();
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
        // publishes the kill board.
        setHealth(0);
        if (onlineMode === 'slayer') {
          setNetEliminated(true);
          return;
        }
        // LMS: you are out — the existing win/lose screen is correct. Stay
        // connected so freeplay:match_end can still deliver the standings.
        // Free play: the server despawned us, so drop the session now.
        setGameState('gameover');
        if (onlineMode === 'free_play') {
          netRef.current?.dispose(); // already settled server-side — no leave emit
          netRef.current = null;
        }
      },
      onMatchEnd: (result) => {
        // SLAYER: no winner — the kill-count scoreboard replaces the verdict.
        // LMS: unchanged victory/defeat.
        setNetResult(result);
        setGameState(result.won ? 'victory' : 'gameover');
        netRef.current?.dispose(); // the match is settled server-side
        netRef.current = null;
      },
      onError: ({ code, message }) => {
        setNetError(message ?? code);
        setNetSearching(false);
        setGameState('menu');
        netRef.current?.dispose();
        netRef.current = null;
      },
    });

    setGameState('playing');
  };

  /**
   * ONLINE: enter on mount, leave on unmount.
   *
   * No "LAUNCH" gate online — picking a mode in the lobby IS the click, so we
   * go straight to matchmaking (slayer/lms) or the world (free play). Start
   * and teardown share ONE effect on purpose: React 18 StrictMode mounts,
   * unmounts and re-mounts in dev, and a separate "start once" guard would
   * leave the second mount with no session.
   *
   * Teardown emits freeplay:leave (in a world) or freeplay:cancel (while
   * queued), so a queue slot can never leak when the view changes.
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

  const startGame = () => {
    if (isNetworkMode) {
      startNetworkGame();
      return;
    }
    setGameState('playing');
    setScore(0);
    setKills(0);
    setHealth(100);

    // Initial zone setup
    const initialSafeZone = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, radius: WORLD_SIZE };
    zoneRef.current = {
      radius: WORLD_SIZE,
      x: WORLD_SIZE / 2,
      y: WORLD_SIZE / 2,
      safeZone: initialSafeZone,
      nextSafeZone: difficulty >= 10 ? generateNextZone(initialSafeZone) : null,
      isShrinking: true, // Start shrinking immediately as in Cells
      phaseTimer: (difficulty === 12 || difficulty === 13) ? 20 : 30,
      phase: 1,
      outsideTimer: 0,
      countdownTimer: null
    };

    setUiZone({
      radius: zoneRef.current.radius,
      x: zoneRef.current.x,
      y: zoneRef.current.y,
      outsideTimer: 0,
      phaseTimer: zoneRef.current.phaseTimer,
      countdownTimer: null
    });
    
    playerRef.current = {
      x: WORLD_SIZE / 2,
      y: WORLD_SIZE / 2,
      vx: 0,
      vy: 0,
      angle: -Math.PI / 2,
      angularVelocity: 0,
      radius: 15,
      rotationSpeed: 0.008,
      angularFriction: 0.88,
      acceleration: 0.2,
      friction: 0.98,
      isHit: false,
      hitTimer: 0,
      kills: 0,
      magazine: 100,
      reserve: 30,
      reloadTimer: 0,
      boostReserve: 0
    };
    reloadHoldTimeRef.current = 0;
    setReloadProgress(0);
    setAmmo({ magazine: 100, reserve: 30, reloading: false });
    setPlayerPos({ x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 });
    cameraRef.current = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
    
    // Reset ratio counters for a new game
    spawnedRegularCountRef.current = 0;
    spawnedHealthCountRef.current = 0;
    spawnedAmmoCountRef.current = 0;

    // Initial asteroids scattered across the world
    const initialAsteroidCount = 30;
    const initialAsteroids = [];
    for (let i = 0; i < initialAsteroidCount; i++) {
      const { subType, color } = getNextAsteroidTypeAndColor();
      initialAsteroids.push({
        x: Math.random() * WORLD_SIZE,
        y: Math.random() * WORLD_SIZE,
        vx: (Math.random() - 0.5) * 3,
        vy: (Math.random() - 0.5) * 3,
        radius: 20 + Math.random() * 40,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.05,
        color,
        subType
      });
    }
    asteroidsRef.current = initialAsteroids;
    
    bulletsRef.current = [];
    botsRef.current = [];
    particlesRef.current = [];
    spawnTimerRef.current = 0;
    botSpawnTimerRef.current = 60;
    
    // Initial bot spawn for modes with no respawns
    if (difficulty >= 10) {
      const botCount = 30;
      for (let i = 0; i < botCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 600 + Math.random() * (WORLD_SIZE * 0.45 - 600); // Spread across the map, keeping away from center
        const x = WORLD_SIZE / 2 + Math.cos(angle) * dist;
        const y = WORLD_SIZE / 2 + Math.sin(angle) * dist;
        
        botsRef.current.push({
          id: `bot-${Math.random().toString(36).substr(2, 5)}`,
          x, y,
          vx: 0, vy: 0,
          angle: Math.random() * Math.PI * 2,
          angularVelocity: 0,
          radius: 15,
          rotationSpeed: 0.008,
          angularFriction: 0.88,
          acceleration: 0.18,
          friction: 0.98,
          type: 'bot',
          nickname: `PILOT-${Math.floor(Math.random() * 9000 + 1000)}`,
          health: 100,
          score: Math.floor(Math.random() * 2000),
          kills: 0
        });
      }
    }
  };

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

  const getMissionName = () => {
    switch (difficulty) {
      case 1: return 'FREE SECTOR: INFINITE';
      case 2: return 'FREE SECTOR: BOUNTY';
      case 3: return 'FREE SECTOR: SURVIVOR';
      // The 2×2 the difficulty selector and the online lobby both name:
      // sector · mode. These used to read SAFE/TOTAL/SURVIVOR/SLAYER, which
      // disagreed with the tiles the player just clicked (and called 13
      // "SLAYER" when 12 is the slayer code). Practice and online share this
      // header now, so it has to match the canonical table exactly.
      case 10: return 'ASTEROID ECLIPSE: SLAYER';
      case 11: return 'ASTEROID ECLIPSE: LAST MAN STANDING';
      case 12: return 'BLITZ: SLAYER';
      case 13: return 'BLITZ: LAST MAN STANDING';
      default: return 'UNKNOWN';
    }
  };

  return (
    <div 
        ref={containerRef} 
        className="relative w-full h-full bg-[#081616] overflow-hidden"
    >
      <canvas 
        ref={canvasRef} 
        width={dimensions.width} 
        height={dimensions.height}
        className="block cursor-none"
      />

      {/* Floating Damage Indicators (Migrated to canvas for performance) */}
      {/* Hitmarker Effect (Migrated to canvas for performance) */}
      {/* Kill Notifications (Migrated to canvas for performance) */}

      {/* Killstreak Notifier */}
      <AnimatePresence>
        {streakNotification && (
          <motion.div
            key={streakNotification.id}
            initial={{ y: -100, opacity: 0, x: '-50%' }}
            animate={{ y: 32, opacity: 1, x: '-50%' }}
            exit={{ y: -120, opacity: 0, x: '-50%' }}
            onAnimationComplete={() => {
              setTimeout(() => setStreakNotification(null), 3000);
            }}
            className="absolute top-0 left-1/2 z-[150] flex flex-col items-center gap-2 pointer-events-none"
          >
            <div className="bg-black/90 backdrop-blur-xl border border-[#00FFD1]/30 px-8 py-4 rounded-2xl shadow-[0_0_50px_rgba(0,255,209,0.2)] flex items-center gap-5">
              <div className="p-3 bg-white/5 rounded-xl border border-white/10 shadow-inner">
                {streakNotification.icon}
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] font-mono text-[#00FFD1]/60 uppercase tracking-[0.4em] leading-none mb-1">Killstreak Acquired</span>
                <span className="text-4xl font-black italic text-white tracking-tighter uppercase leading-none">
                  {streakNotification.text}
                </span>
              </div>
            </div>
            <motion.div 
               initial={{ scaleX: 1 }}
               animate={{ scaleX: 0 }}
               transition={{ duration: 3, ease: "linear" }}
               className="w-full h-1 bg-[#00FFD1] origin-left rounded-full shadow-[0_0_10px_#00FFD1]"
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {gameState === 'playing' && (
          <>
            {/* Top Left HUD: Profile & Score */}
            <motion.div 
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              className="absolute top-8 left-8 space-y-4 pointer-events-none z-[60]"
            >
              <div className="backdrop-blur-md bg-black/40 border border-[#00FFD1]/20 p-4 rounded-2xl flex items-center gap-4">
                <div className="w-12 h-12 rounded-full border-2 border-[#00FFD1] bg-[#00FFD1]/10 flex items-center justify-center overflow-hidden">
                  <img src={profile?.avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                </div>
                <div>
                  <p className="text-xs font-mono text-[#00FFD1]/60 uppercase tracking-widest leading-none mb-1">Interceptor</p>
                  <p className="text-xl font-black text-white italic uppercase tracking-tighter leading-none">{profile?.name || 'Vanguard'}</p>
                </div>
              </div>

              <div className="flex gap-2">
                <div className="backdrop-blur-md bg-black/40 border border-[#00FFD1]/20 px-6 py-3 rounded-xl flex items-center gap-3">
                  <Skull className="w-4 h-4 text-[#00FFD1]" />
                  <div className="text-left">
                    <p className="text-[10px] font-mono text-white/40 uppercase leading-none">Kills</p>
                    <p className="text-lg font-black text-[#00FFD1] italic tracking-tighter leading-none mt-1">{kills}</p>
                  </div>
                </div>
                {/* Online: mode badge where the SOL pot used to be — no money HUD. */}
                {isNetworkMode && (
                  <div className="backdrop-blur-md bg-black/40 border border-[#00FFD1]/20 px-6 py-3 rounded-xl flex items-center gap-3">
                    <Navigation className="w-4 h-4 text-[#00FFD1]" />
                    <div className="text-left">
                      <p className="text-[10px] font-mono text-white/40 uppercase leading-none">Online</p>
                      <p className="text-lg font-black text-[#00FFD1] italic tracking-tighter leading-none mt-1 uppercase">
                        {onlineLabel}
                      </p>
                    </div>
                  </div>
                )}
                <div className="backdrop-blur-md bg-black/40 border border-[#00FFD1]/20 px-6 py-3 rounded-xl flex items-center gap-3">
                  <Heart className={`w-4 h-4 ${health < 30 ? 'text-red-500 animate-pulse' : 'text-[#FF0080]'}`} />
                  <div className="text-left">
                    <p className="text-[10px] font-mono text-white/40 uppercase leading-none">Health</p>
                    <p className="text-lg font-black text-white italic tracking-tighter leading-none mt-1">{Math.floor(health)}%</p>
                  </div>
                </div>
                {boostReserveState > 0 && (
                  <div className={`backdrop-blur-md bg-black/40 border ${isBoosting ? 'border-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.3)]' : 'border-[#00FFD1]/20'} px-6 py-3 rounded-xl flex items-center gap-3 transition-colors`}>
                    <Zap className={`w-4 h-4 ${isBoosting ? 'text-yellow-500 animate-pulse' : 'text-[#00FFD1]'}`} />
                    <div className="text-left">
                      <p className="text-[10px] font-mono text-white/40 uppercase leading-none">Boost</p>
                      <p className={`text-lg font-black italic tracking-tighter leading-none mt-1 ${isBoosting ? 'text-yellow-500' : 'text-[#00FFD1]'}`}>
                        {boostReserveState > 0 ? `${boostReserveState.toFixed(1)}s` : '0.0s'}
                      </p>
                    </div>
                  </div>
                )}
                <div 
                  className={`backdrop-blur-md bg-black/40 border border-[#00FFD1]/20 px-6 py-3 rounded-xl flex items-center gap-3 cursor-pointer select-none hover:bg-black/60 transition-all ${ammo.magazine === 0 && !ammo.reloading ? 'animate-pulse border-red-500' : ''}`}
                  onClick={() => {
                    if (isNetworkMode) {
                      // Server-side reload: pulse the reload input flag for a
                      // few ticks; the server drives the actual 1.5s timer.
                      reloadPulseUntilRef.current = performance.now() + 250;
                      triggerReload();
                      return;
                    }
                    if (!ammo.reloading && ammo.magazine < 100 && ammo.reserve > 0) {
                      playerRef.current.reloadTimer = 1.5;
                      triggerReload();
                      setAmmo(a => ({...a, reloading: true}));
                    }
                  }}
                  title="Reload (Press R or Click)"
                >
                  <div className="w-6 h-6 flex items-center justify-center text-[#00aaff] relative">
                    {reloadProgress > 0 && (
                      <svg className="absolute w-8 h-8 -rotate-90 pointer-events-none" viewBox="0 0 36 36">
                        <circle
                          cx="18"
                          cy="18"
                          r="14"
                          stroke="rgba(0, 255, 209, 0.15)"
                          strokeWidth="3.5"
                          fill="transparent"
                        />
                        <circle
                          cx="18"
                          cy="18"
                          r="14"
                          stroke="#00FFD1"
                          strokeWidth="3.5"
                          fill="transparent"
                          strokeDasharray={2 * Math.PI * 14}
                          strokeDashoffset={2 * Math.PI * 14 * (1 - reloadProgress)}
                          strokeLinecap="round"
                        />
                      </svg>
                    )}
                    {ammo.reloading ? <RefreshCw className="w-3.5 h-3.5 animate-spin text-orange-400" /> : <Target className="w-4 h-4" />}
                  </div>
                  <div className="text-left">
                    <p className="text-[10px] font-mono text-white/40 uppercase leading-none">
                      Ammo {ammo.reloading && `(${Math.floor(reloadProgress * 100)}%)`} <span className="hidden sm:inline border border-white/20 rounded px-1 ml-1 text-xs">PRESS R</span>
                    </p>
                    {/* Online there is no reserve pool — reloads always refill */}
                    <p className="text-lg font-black text-white italic tracking-tighter leading-none mt-1">{ammo.magazine} / {isNetworkMode ? '∞' : ammo.reserve}</p>
                  </div>
                </div>
              </div>
            </motion.div>

            {/* Top Center: Mission Status */}
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className="absolute top-8 left-1/2 -translate-x-1/2 pointer-events-none z-[60] flex flex-col items-center gap-4"
            >
              <div className="backdrop-blur-xl bg-black/60 border border-white/10 px-8 py-4 rounded-3xl flex items-center gap-6 shadow-2xl">
                <div className="p-2 rounded-xl bg-[#00FFD1]/20 text-[#00FFD1]">
                  <Navigation className="w-5 h-5 animate-pulse" />
                </div>
                <div className="text-center min-w-[140px]">
                  <p className="text-[10px] font-mono text-white/40 uppercase tracking-[0.2em]">Zone</p>
                  <p className="text-2xl font-black italic tracking-tighter text-white uppercase">{getMissionName()}</p>
                </div>
              </div>

              {difficulty !== 1 && (
                <div className="flex gap-2">
                  <div className="backdrop-blur-md bg-black/40 border border-white/10 px-4 py-2 rounded-xl flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-[#FF0080] animate-pulse" />
                    <p className="text-[10px] font-mono text-white/60 tracking-widest uppercase">
                      {zoneRef.current.isShrinking ? 'Zone Collapsing' : `Stabilization: ${Math.ceil(uiZone.phaseTimer)}s`}
                    </p>
                  </div>
                  {uiZone.outsideTimer > 0 && (
                    <div className="backdrop-blur-md bg-red-500/20 border border-red-500/50 px-4 py-2 rounded-xl flex items-center gap-2 animate-bounce">
                      <p className="text-[10px] font-mono text-red-500 font-bold tracking-widest uppercase">
                        WARNING: {Math.ceil(MAX_OUTSIDE_TIME - uiZone.outsideTimer)}s REMAINING
                      </p>
                    </div>
                  )}
                </div>
              )}
            </motion.div>

            {/* Top Right: Leaderboard */}
            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="absolute top-8 right-8 w-64 pointer-events-none z-[60]"
            >
              <div className="backdrop-blur-md bg-black/40 border border-[#00FFD1]/20 p-6 rounded-2xl">
                <div className="flex items-center gap-3 mb-4">
                  <Trophy className="w-4 h-4 text-yellow-500" />
                  <h3 className="text-xs font-black text-white italic uppercase tracking-widest">Leaderboard</h3>
                </div>
                <div className="space-y-2">
                  {leaderboard.map((entry, idx) => (
                    <div 
                      key={idx} 
                      className={`flex items-center justify-between p-2 rounded-lg text-[10px] font-mono border ${
                        entry.isPlayer 
                        ? 'bg-[#00FFD1]/10 text-[#00FFD1] border-[#00FFD1]/20' 
                        : 'text-white/20 border-white/5'
                      }`}
                    >
                      <span className="opacity-50">#{idx + 1}</span>
                      <span className="flex-1 px-3 truncate italic uppercase">{entry.name}</span>
                      {/* Ranking column: kills, online and in practice. */}
                      <span className="font-bold">{Number(entry.kills ?? 0)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>

            {/* Bottom Left: Mini Map & New HUD Status */}
            <motion.div 
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="absolute bottom-8 left-8 flex items-end gap-4 pointer-events-none z-[60]"
            >
              <MiniMap 
                player={playerPos}
                worldSize={WORLD_SIZE}
                difficulty={difficulty}
                rank={leaderboardRef.current.findIndex(e => e.isPlayer) + 1}
                zoneInfo={{
                  x: zoneRef.current.x,
                  y: zoneRef.current.y,
                  radius: zoneRef.current.radius,
                  nextSafeZone: zoneRef.current.nextSafeZone
                }}
              />

              <div className="flex flex-col gap-2">
                {/* New Status Bar */}
                <div className="backdrop-blur-xl bg-black/60 border border-white/10 p-4 rounded-2xl w-64 shadow-2xl">
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-[10px] font-mono text-[#00FFD1] uppercase tracking-widest">Health</span>
                        <span className="text-xs font-bold text-white tracking-widest">{health}%</span>
                    </div>
                    <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden border border-white/5">
                        <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${health}%` }}
                            className={`h-full ${health < 30 ? 'bg-red-500' : 'bg-[#00FFD1]'} relative`}
                        >
                            <div className="absolute inset-0 bg-white/20 animate-pulse" />
                        </motion.div>
                    </div>
                </div>
              </div>
            </motion.div>

            {/* Bottom Right: Controls */}
            <div className="absolute bottom-8 right-8 flex gap-3 pointer-events-auto z-[70]">
              {/* Menu Button as requested: "put the menu button right next to the 3 [buttons]" */}
              <button
                onClick={() => {
                  if (isFullscreen) return;
                  window.dispatchEvent(new CustomEvent('open-neon-arcade-menu'));
                }}
                disabled={isFullscreen}
                className={`p-4 bg-white/5 border border-white/10 rounded-2xl text-[#00FFD1] transition-all shadow-2xl flex items-center justify-center select-none active:scale-90 ${
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
                className="p-4 bg-white/5 border border-white/10 rounded-2xl text-[#00FFD1] hover:bg-[#00FFD1]/10 hover:border-[#00FFD1]/50 transition-all shadow-2xl flex items-center justify-center cursor-pointer select-none active:scale-90"
                title={isMuted ? "Unmute Sound" : "Mute Sound"}
              >
                {isMuted ? <VolumeX className="w-6 h-6 text-red-500" /> : <Volume2 className="w-6 h-6" />}
              </button>

              <button 
                onClick={toggleFullscreen}
                className="p-4 bg-white/5 border border-white/10 rounded-2xl text-[#00FFD1] hover:bg-[#00FFD1]/10 transition-all shadow-2xl active:scale-90"
                title="Toggle Fullscreen (F)"
              >
                <Maximize className="w-6 h-6" />
              </button>
              <GameBackButton onClick={onExit} title="Exit Game" />
            </div>

            {/* Cashout Button for Free Play Wager */}
            {wagerMode === 'free_play' && (
              <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-[70] pointer-events-auto">
                <button
                  onMouseDown={handleCashoutDown}
                  onMouseUp={handleCashoutUp}
                  onMouseLeave={handleCashoutUp}
                  onTouchStart={handleCashoutDown}
                  onTouchEnd={handleCashoutUp}
                  className={`px-8 py-4 rounded-xl font-mono text-xs font-black tracking-widest uppercase border select-none transition-all ${
                    (playerRef.current?.kills ?? 0) > 0
                      ? 'bg-yellow-500/10 border-yellow-500 text-yellow-500 shadow-[0_0_20px_rgba(234,179,8,0.2)] hover:bg-yellow-500/25 active:scale-95 cursor-pointer'
                      : 'bg-white/5 border-white/10 text-white/30 cursor-not-allowed'
                  }`}
                >
                  <div className="flex items-center justify-center gap-1.5">
                    {(playerRef.current?.kills ?? 0) > 0 ? (
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
                      style={{ width: `${cashoutHoldProgress * 100}%` }}
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </AnimatePresence>

      {/* ONLINE: matchmaking. Shown IMMEDIATELY on entry for slayer/lms —
          never waits for a server ack. free_play never shows this screen. */}
      {netSearching && isQueuedOnline && (
        <div className="absolute inset-0 z-[95] bg-[#081616]/95 backdrop-blur-xl">
          <SearchingForMatch
            playersInQueue={netQueue.current}
            playersNeeded={netQueue.needed}
            subtitle={`Neon Asteroids · ${onlineLabel}`}
            onCancel={() => {
              netRef.current?.cancel();
              netRef.current = null;
              setNetSearching(false);
              onExit();
            }}
          />
        </div>
      )}

      {/* ONLINE (lobby modes): match found — the server's start countdown. */}
      {isQueuedOnline && !netSearching && netMatch?.status === 'waiting' && gameState === 'playing' && (
        <div className="absolute inset-0 z-[90] flex items-center justify-center pointer-events-none bg-black/60 backdrop-blur-sm">
          <div className="text-center space-y-3">
            <p className="text-[#00FFD1] font-mono text-sm tracking-[0.4em] uppercase">Match found</p>
            <p className="text-8xl font-black italic text-white">{Math.ceil(netMatch.startsIn / 1000)}</p>
            <p className="text-white/50 font-mono text-xs uppercase tracking-widest">
              {netMatch.total} pilots · no bots
            </p>
          </div>
        </div>
      )}

      {/* ONLINE: respawn countdown after a player kill (free play) */}
      {isNetworkMode && respawnInfo && gameState === 'playing' && (
        <div className="absolute inset-0 z-[85] flex items-center justify-center pointer-events-none bg-black/50 backdrop-blur-sm">
          <div className="text-center space-y-3">
            <p className="text-red-500 font-mono text-sm tracking-[0.4em] uppercase">Shot down by {respawnInfo.by}</p>
            <p className="text-8xl font-black italic text-white">{respawnRemaining.toFixed(1)}s</p>
            <p className="text-white/50 font-mono text-xs uppercase tracking-widest">Redeploying</p>
          </div>
        </div>
      )}

      {/* ONLINE (slayer): shot down, waiting for the kill board. Slayer has no
          defeat screen — the match is still running for everybody else. */}
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

      {/* Blitz Countdown Overlay */}
      {uiZone.countdownTimer !== null && (
        <div className="absolute inset-0 flex items-center justify-center z-[80] pointer-events-none">
          <motion.div 
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: [0.5, 1.2, 1], opacity: 1 }}
            key={Math.floor(uiZone.countdownTimer)}
            className="flex flex-col items-center"
          >
            <p className="text-white/40 font-mono text-sm tracking-[0.4em] uppercase mb-4">Zone Shrink Incoming</p>
            <p className="text-9xl font-black italic text-[#FF0080] tracking-tighter drop-shadow-[0_0_50px_rgba(255,0,128,0.5)]">
               {Math.ceil(uiZone.countdownTimer)}
            </p>
          </motion.div>
        </div>
      )}

      {/* Menu Overlays */}
      <AnimatePresence>
        {gameState === 'menu' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md"
          >
            <div className="max-w-md w-full p-8 text-center">
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                className="mb-8"
              >
                 <div className="w-20 h-20 bg-[#00FFD1]/10 rounded-3xl border border-[#00FFD1]/20 flex items-center justify-center mx-auto mb-6 shadow-[0_0_50px_rgba(0,255,209,0.2)]">
                    <Gamepad2 className="w-10 h-10 text-[#00FFD1]" />
                </div>
                <h2 className="text-5xl font-black italic text-white uppercase tracking-tighter mb-2 italic">
                    NEON <br /> <span className="text-[#00FFD1]">ASTEROIDS</span>
                </h2>
                <p className="text-[#00FFD1]/60 font-mono text-sm tracking-[0.2em] uppercase">Deep Space Interceptor Protocol</p>
              </motion.div>

              <div className="space-y-4">
                <button 
                  onClick={startGame}
                  className="w-full py-5 bg-[#00FFD1] text-[#00382c] font-black uppercase tracking-[0.3em] rounded-2xl hover:scale-105 active:scale-95 transition-all shadow-[0_0_40px_rgba(0,255,209,0.4)]"
                >
                  Initiate Mission
                </button>
                <button 
                  onClick={onExit}
                  className="w-full py-5 border border-white/10 text-white font-black uppercase tracking-[0.3em] rounded-2xl hover:bg-white/5 transition-all"
                >
                  Return to Arcade
                </button>
              </div>

              <div className="mt-12 grid grid-cols-2 gap-4">
                <div className="p-4 rounded-xl bg-white/5 border border-white/5">
                    <p className="text-[10px] text-[#00FFD1]/60 uppercase font-mono tracking-widest mb-1">Rotation</p>
                    <p className="text-white font-bold text-sm">A / D or L / R Arrow</p>
                </div>
                <div className="p-4 rounded-xl bg-white/5 border border-white/5">
                    <p className="text-[10px] text-[#00FFD1]/60 uppercase font-mono tracking-widest mb-1">Thrust</p>
                    <p className="text-white font-bold text-sm">Auto-drive</p>
                </div>
                <div className="p-4 rounded-xl bg-white/5 border border-white/5 col-span-2">
                    <p className="text-[10px] text-[#00FFD1]/60 uppercase font-mono tracking-widest mb-1">Weapons & Reload</p>
                    <p className="text-white font-bold text-sm">Space / Click to Shoot, Press R / Click UI Button to Reload (1.5s)</p>
                </div>
              </div>
            </div>

            <div className="absolute bottom-8 right-8">
              <button
                onClick={toggleFullscreen}
                className="p-4 bg-white/5 border border-white/10 rounded-2xl text-[#00FFD1] hover:bg-[#00FFD1]/10 transition-all shadow-2xl active:scale-90"
                title="Toggle Fullscreen (F)"
              >
                <Maximize className="w-6 h-6" />
              </button>
            </div>
          </motion.div>
        )}

        {/* SLAYER (online): the kill board replaces the victory/defeat screen. */}
        {(gameState === 'victory' || gameState === 'gameover') && isNetworkMode && netResult?.scoring === 'kills' && (
          <SlayerScoreboard
            result={netResult}
            gameMode={onlineLabel}
            onRematch={startNetworkGame}
            onExit={onExit}
          />
        )}

        {(gameState === 'victory' || gameState === 'gameover') && !(isNetworkMode && netResult?.scoring === 'kills') && (
          <ResultsScreen
            won={gameState === 'victory'}
            stake={isNetworkMode ? 0 : (wagerMode ? wagerAmount : 0)}
            winnings={isNetworkMode ? 0 : (wagerMode ? sessionWinnings : 0)}
            gameMode={isNetworkMode
              ? `Online - ${onlineLabel}`
              : (wagerMode ? `Practice Wager - ${wagerMode}` : 'Practice')}
            // Online stakes nothing — hide the Wagered/Payout rows.
            moneyless={isNetworkMode}
            kills={kills}
            onRematch={startGame}
            onExit={onExit}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default AsteroidsCore;

// MiniMap Component moved outside for stability
const MiniMap = ({ player, worldSize, difficulty, rank, zoneInfo }: { player: {x: number, y: number}, worldSize: number, difficulty: number, rank: number, zoneInfo: any }) => {
  const mapSize = 150;
  const effectiveWorldSize = worldSize || 8000;
  
  // Scale factor to fit the square world diagonal inside the circular map
  // sqrt(2) approx 1.414, we use 1.45 for a small margin
  const scale = mapSize / (effectiveWorldSize * 1.45);
  
  const toMapX = (x: number) => (x - effectiveWorldSize / 2) * scale + mapSize / 2;
  const toMapY = (y: number) => (y - effectiveWorldSize / 2) * scale + mapSize / 2;

  const showZone = difficulty >= 10;

  return (
    <div className="w-[150px] h-[150px] bg-black/60 backdrop-blur-xl rounded-full border border-white/10 overflow-hidden relative shadow-2xl">
      {/* World boundary indicators */}
      <div className="absolute inset-0 opacity-5 pointer-events-none">
        <div className="absolute top-1/2 w-full h-px bg-white/20" />
        <div className="absolute left-1/2 h-full w-px bg-white/20" />
      </div>
      
      {/* Red Zone (Danger Area) */}
      {showZone && (
        <div 
          className="absolute inset-0 bg-red-600/30 pointer-events-none"
          style={{
            maskImage: `radial-gradient(circle at ${toMapX(zoneInfo.x)}px ${toMapY(zoneInfo.y)}px, transparent ${zoneInfo.radius * scale}px, black ${zoneInfo.radius * scale}px)`,
            WebkitMaskImage: `radial-gradient(circle at ${toMapX(zoneInfo.x)}px ${toMapY(zoneInfo.y)}px, transparent ${zoneInfo.radius * scale}px, black ${zoneInfo.radius * scale}px)`
          }}
        />
      )}

      {/* Safe Zone (Next) */}
      {showZone && zoneInfo.nextSafeZone && (
        <div 
          className="absolute rounded-full border border-[#00FFD1]/30 bg-[#00FFD1]/5"
          style={{
            width: zoneInfo.nextSafeZone.radius * scale * 2,
            height: zoneInfo.nextSafeZone.radius * scale * 2,
            left: toMapX(zoneInfo.nextSafeZone.x) - zoneInfo.nextSafeZone.radius * scale,
            top: toMapY(zoneInfo.nextSafeZone.y) - zoneInfo.nextSafeZone.radius * scale,
          }}
        />
      )}

      {/* Current Zone */}
      {showZone && (
        <div 
          className="absolute rounded-full border border-[#FF0080]/40 bg-[#FF0080]/5 animate-pulse"
          style={{
            width: zoneInfo.radius * scale * 2,
            height: zoneInfo.radius * scale * 2,
            left: toMapX(zoneInfo.x) - zoneInfo.radius * scale,
            top: toMapY(zoneInfo.y) - zoneInfo.radius * scale,
          }}
        />
      )}

      {/* Player Indicator - Small Glowing Dot */}
      <div 
        className="absolute w-3 h-3 bg-[#00FFD1] rounded-full shadow-[0_0_10px_#00FFD1] z-40 border border-white/50"
        style={{
          left: toMapX(player?.x || 0) - 6,
          top: toMapY(player?.y || 0) - 6,
          transform: 'translateZ(0)'
        }}
      />
    </div>
  );
};
