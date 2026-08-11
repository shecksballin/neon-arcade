// src/components/Cells/ArgarGame.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Maximize, Minimize, RefreshCw, Trophy, Activity, Target, Timer, Zap, Menu, Volume2, VolumeX } from 'lucide-react';
import GameBackButton from '../common/GameBackButton';
import { GameEngine, type Entity } from './gameEngine';
import { ResultsScreen } from '../NeonBucks/ResultsScreen';
import { useNeonBucks } from '../../NeonBucksStore';
import { FreeplayNet, type NetFood } from '../../lib/freeplayNet';

// ---------------------------------------------------------------------------
// NETWORK-MODE ADAPTER HELPERS (free-play multiplayer)
// The server is authoritative; these helpers map interpolated server players
// into the Entity/Food shapes the existing canvas draw code already expects,
// so the render path itself stays untouched.
// ---------------------------------------------------------------------------

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
  profile: { name: string; avatarUrl: string } | null;
  onExit: () => void;
  wagerAmount?: number;
  wagerMode?: 'free_play' | 'slayer' | 'snake' | null;
  targetKills?: number;
}

const ArgarGame: React.FC<ArgarGameProps> = ({ difficulty: difficultyProp = 3, isMultiplayer = false, profile, onExit, wagerAmount = 0, wagerMode = null, targetKills }) => {
  // NETWORK MODE: true only for the online free-play (wager) path. Derived ONCE
  // per mount — every multiplayer branch below keys off this single boolean.
  const isNetworkMode = isMultiplayer && wagerMode === 'free_play';
  // The server free-play world has no shrink zone. Difficulty 1 is the local
  // "Free Play / no zone" ruleset, so forcing it online disables every zone
  // render/HUD path without touching any practice-mode code.
  const difficulty = isNetworkMode ? 1 : difficultyProp;

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [gameState, setGameState] = useState<'menu' | 'countdown' | 'playing' | 'gameOver'>('menu');
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

  // ── Network-mode session state (free-play multiplayer only) ───────────────
  const netRef = useRef<FreeplayNet | null>(null);
  const netInputRef = useRef({ dx: 0, dy: 0, boost: false });
  const netEnemyCacheRef = useRef(new Map<string, Entity>()); // id -> render adapter
  const netFoodSrcRef = useRef<NetFood[] | null>(null);       // identity cache: skip re-mapping unchanged food
  const netFoodMappedRef = useRef<{ x: number; y: number; radius: number; color: string }[]>([]);
  const [netJoined, setNetJoined] = useState(false);
  const [netPot, setNetPot] = useState(0);                    // SOL ledger value echoed by the server
  const [netEntryFee, setNetEntryFee] = useState(0);
  const [netError, setNetError] = useState<string | null>(null);
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

  useEffect(() => {
    if (gameState === 'gameOver' && gameResult) {
       // NETWORK MODE: payouts live in the server ledger only — NeonBucks is
       // never touched online; sessionWinnings is set by the server events.
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
          } else if (wagerMode === 'snake') {
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
    }
  }, [gameState, gameResult, playEffect, wagerAmount, wagerMode, win]);

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

  // NETWORK MODE: leaving the component mid-session is a voluntary despawn —
  // freeplay:leave makes the server auto-cash-out the current pot.
  useEffect(() => {
    if (!isNetworkMode) return;
    return () => {
      netRef.current?.leave();
      netRef.current = null;
    };
  }, [isNetworkMode]);

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

    if (view) {
      // Own cell: position/radius come from the server only (null while dead).
      if (view.you) {
        const you = view.you;
        const r = Number(you.r ?? you.radius ?? engine.player.radius);
        engine.player.x = you.x;
        engine.player.y = you.y;
        engine.player.radius = r;
        const cell0 = engine.player.cells[0];
        if (cell0) {
          cell0.x = you.x;
          cell0.y = you.y;
          cell0.radius = r;
        }
        engine.player.score = Number(you.mass ?? you.score ?? r);
      }
      // Local boost input drives the glow instantly; the server confirms via speed.
      engine.player.isBoosting = netInputRef.current.boost;
      engine.player.boostTimer = netInputRef.current.boost ? 1 : 0;

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
        const r = Number(pl.r ?? pl.radius ?? 15);
        ent.x = pl.x;
        ent.y = pl.y;
        ent.radius = r;
        ent.nickname = pl.name ?? 'UNKNOWN';
        ent.score = Number(pl.pot ?? 0);
        ent.isBoosting = !!pl.boosting;
        ent.boostTimer = pl.boosting ? 1 : 0;
        const c = ent.cells[0];
        c.x = pl.x;
        c.y = pl.y;
        c.radius = r;
        return ent;
      });
      // Prune adapters for players that left our view.
      for (const id of Array.from(cache.keys())) {
        if (!seen.has(id)) cache.delete(id);
      }

      // Food: re-map only when the delta-accumulated array actually changed.
      if (view.food !== netFoodSrcRef.current) {
        netFoodSrcRef.current = view.food;
        netFoodMappedRef.current = view.food.map((f) => ({
          x: f.x,
          y: f.y,
          radius: f.radius ?? 8,
          color: f.color ?? '#00E0B7',
        }));
      }
      engine.food = netFoodMappedRef.current;

      // Leaderboard: server sends [{name, pot}] — adapt to the HUD entry shape
      // (score column shows the pot; the JSX formats it as SOL online).
      setLeaderboard(
        view.leaderboard.map((l) => ({
          name: l.name,
          score: l.pot,
          color: '#00FFD1',
          isPlayer: !!profile?.name && l.name === profile.name,
        }))
      );
    }

    // Publish input: normalized mouse direction from the screen centre (the
    // player's cell is camera-locked there) + the boost key. Sent at 20Hz by
    // the FreeplayNet interval; we just keep the latest values fresh.
    const mdx = engine.mouseX - engine.width / 2;
    const mdy = engine.mouseY - engine.height / 2;
    const len = Math.hypot(mdx, mdy);
    const DEADZONE_PX = 12; // cell rests when the cursor sits on top of it
    netInputRef.current.dx = len > DEADZONE_PX ? mdx / len : 0;
    netInputRef.current.dy = len > DEADZONE_PX ? mdy / len : 0;
    net?.setInput({ ...netInputRef.current });

    // Camera + the same lightweight HUD sync the local path performs.
    engine.updateCamera();
    setScore(Math.floor(engine.player.score));
    setPlayerCellCount(1);
    setPlayerPos({ x: engine.player.x, y: engine.player.y });
    setCameraState({ x: engine.camera.x, y: engine.camera.y, zoom: engine.camera.zoom });
    setWorldSize({ width: engine.worldWidth, height: engine.worldHeight });
    setIsBoosting(netInputRef.current.boost);
  }, [profile]);

  const gameLoop = useCallback((time: number) => {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;

    const dt = time - lastTimeRef.current;
    lastTimeRef.current = time;

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

    if (wagerMode === 'free_play' && targetKills !== undefined && engine.player.kills >= targetKills && engine.gameState !== 'gameOver') {
       engine.gameState = 'gameOver';
       engine.gameResult = 'win';
    } else if ((wagerMode === 'slayer' || wagerMode === 'snake') && engine.enemies.length === 0 && engine.gameState !== 'gameOver') {
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
  }, [renderGame, networkFrame, isNetworkMode]);

  useEffect(() => {
    if (gameState === 'playing') {
      animationFrameRef.current = requestAnimationFrame(gameLoop);
    } else if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
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
    if (e.code === 'KeyF') {
      e.preventDefault();
      toggleFullscreen();
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
   * NETWORK MODE: join (or re-join after a session ended) the permanent
   * free-play world. All money/HUD state below is driven purely by server
   * events — nothing here ever touches NeonBucks.
   */
  const startNetworkGame = () => {
    setNetError(null);
    setNetJoined(false);
    setNetPot(0);
    setKills(0);
    setRespawnInfo(null);
    setSessionWinnings(0);
    netEnemyCacheRef.current.clear();
    netFoodSrcRef.current = null;
    netFoodMappedRef.current = [];

    netRef.current?.dispose(); // safety: never stack two sessions
    const net = new FreeplayNet('cells');
    netRef.current = net;
    net.join({
      onJoined: (info) => {
        // The server's world size wins over the canvas-derived local guess.
        const engine = engineRef.current;
        if (engine) {
          engine.worldWidth = info.world.w;
          engine.worldHeight = info.world.h;
        }
        setNetEntryFee(info.entryFee);
        setNetPot(info.entryFee);
        setNetJoined(true);
      },
      onPot: ({ pot, kills: k }) => {
        setNetPot(pot);
        setKills(k);
      },
      onKill: ({ victimName }) => {
        // No coords in the payload — anchor the notification on our own cell.
        const engine = engineRef.current;
        addKillNotification({ name: victimName, x: engine?.player.x ?? 0, y: engine?.player.y ?? 0 });
      },
      onKilled: ({ by, respawnIn }) => {
        setRespawnInfo({ by, until: Date.now() + respawnIn });
        // Death always aborts a cash-out hold in progress (server did too).
        setIsCashingOut(false);
        setCashoutHoldProgress(0);
        cashoutStartTime.current = null;
      },
      onRespawn: ({ pot }) => {
        setRespawnInfo(null);
        setNetPot(pot);
      },
      onEliminated: ({ potLost }) => {
        // Environment death: pot goes to the house, session over.
        setSessionWinnings(-potLost);
        setGameResult('lost');
        setGameState('gameOver');
        if (engineRef.current) engineRef.current.gameState = 'gameOver';
        netRef.current?.dispose(); // already settled server-side — no leave emit
        netRef.current = null;
      },
      onCashoutConfirmed: ({ payout, kills: k }) => {
        // The ONLY way a cash-out completes: the server confirmed the payout.
        setSessionWinnings(payout);
        setKills(k);
        setGameResult('win');
        setGameState('gameOver');
        if (engineRef.current) engineRef.current.gameState = 'gameOver';
        netRef.current?.dispose();
        netRef.current = null;
      },
      onError: ({ code, message }) => {
        setNetError(message ?? code);
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
      engineRef.current.gameState = 'playing';
      setGameState('playing');
    }
  };

  const resetGame = () => {
    if (isNetworkMode) {
      startNetworkGame();
      return;
    }
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

  // Network mode: any live pot can be cashed out (it always holds at least the
  // entry fee); practice keeps the original kills>0 gate.
  const canCashout = isNetworkMode ? netPot > 0 : kills > 0;

  const handleCashoutDown = () => {
     if (gameState === 'playing' && canCashout && wagerMode === 'free_play') {
        setIsCashingOut(true);
        cashoutStartTime.current = performance.now();
        // The server runs its own authoritative 3s hold timer (and slows us);
        // the local bar is only visual feedback.
        if (isNetworkMode) netRef.current?.startCashout();
     }
  };

  const handleCashoutUp = () => {
     if (isNetworkMode && isCashingOut) netRef.current?.cancelCashout();
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
           if (p >= 1 && isNetworkMode) {
               // Pin the bar at full and WAIT: only the server's
               // freeplay:cashout_confirmed event ends a network session.
               af = requestAnimationFrame(tickCashout);
           } else if (p >= 1 && engineRef.current) {
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
          {/* Network mode: live pot (server ledger, SOL units) */}
          {isNetworkMode && (
            <div className="backdrop-blur-md bg-black/40 border border-yellow-500/20 px-6 py-3 rounded-xl flex items-center gap-3">
               <Trophy className="w-4 h-4 text-yellow-500" />
               <div className="text-left">
                  <p className="text-[10px] font-mono text-white/40 uppercase">Pot (SOL)</p>
                  <p className="text-lg font-black text-yellow-500 italic tracking-tighter leading-none mt-1">{netPot.toFixed(3)}</p>
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

      {/* HUD: Top Right - Leaderboard */}
      <div className="absolute top-8 right-8 w-64 pointer-events-none z-[60]">
        <div className="backdrop-blur-md bg-black/40 border border-[#00FFD1]/20 p-6 rounded-2xl">
          <div className="flex items-center gap-3 mb-4">
            <Trophy className="w-5 h-5 text-yellow-500" />
            <h3 className="text-xs font-black text-white italic uppercase tracking-widest">Leaderboard</h3>
          </div>
          <div className="space-y-2">
            {leaderboard.map((entry, idx) => (
              <div 
                key={idx}
                className={`flex items-center justify-between p-2 rounded-lg text-[10px] font-mono ${
                  entry.isPlayer ? 'bg-[#00FFD1]/10 text-[#00FFD1]' : 'text-white/40'
                }`}
              >
                <span className="opacity-50">#{idx + 1}</span>
                <span className="flex-1 px-3 truncate">{entry.name}</span>
                {/* Online the score column is the SOL pot — keep the decimals */}
                <span className="font-bold">{isNetworkMode ? Number(entry.score ?? 0).toFixed(3) : Math.floor(entry.score)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

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
        <GameBackButton onClick={onExit} title="Exit Game" />
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
                isNetworkMode ? (
                  // Online pots are SOL ledger values, not NeonBucks.
                  <>HOLD TO CASHOUT {netPot.toFixed(3)} SOL</>
                ) : (
                  <>HOLD TO CASHOUT <img src="/neon-bucks-icon.png" alt="NB" referrerPolicy="no-referrer" className="h-5 w-auto drop-shadow-[0_0_5px_rgba(234,179,8,0.5)]" /></>
                )
              ) : (
                isNetworkMode ? 'SYNCING POT...' : 'GET A KILL TO CASHOUT'
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

      {/* NETWORK MODE: respawn countdown after a player kill (pot was stolen) */}
      {isNetworkMode && respawnInfo && gameState === 'playing' && (
        <div className="absolute inset-0 z-[85] flex items-center justify-center pointer-events-none bg-black/50 backdrop-blur-sm">
          <div className="text-center space-y-3">
            <p className="text-red-500 font-mono text-sm tracking-[0.4em] uppercase">Consumed by {respawnInfo.by}</p>
            <p className="text-8xl font-black italic text-white">{respawnRemaining.toFixed(1)}s</p>
            <p className="text-white/50 font-mono text-xs uppercase tracking-widest">Pot reset to entry fee — redeploying</p>
          </div>
        </div>
      )}

      {/* NETWORK MODE: joining indicator until the first server state lands */}
      {isNetworkMode && gameState === 'playing' && !netJoined && (
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

        {gameState === 'gameOver' && (
          <ResultsScreen
            won={gameResult === 'win'}
            stake={isNetworkMode ? netEntryFee : (wagerMode ? wagerAmount : 0)}
            winnings={isNetworkMode ? sessionWinnings : (wagerMode ? sessionWinnings : 0)}
            gameMode={isNetworkMode ? 'Online Free Play (SOL)' : (wagerMode ? `Practice Wager - ${wagerMode}` : (isMultiplayer ? 'Online' : 'Practice'))}
            kills={kills}
            onRematch={resetGame}
            onExit={onExit}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default ArgarGame;
