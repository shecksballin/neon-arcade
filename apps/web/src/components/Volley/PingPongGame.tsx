import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import { Zap } from 'lucide-react';
import { ResultsScreen } from '../NeonBucks/ResultsScreen';
import { useNeonBucks } from '../../NeonBucksStore';
// The per-player "+XP / rank change" event, chained after the results screen.
import { useMatchProgression } from '../../hooks/useGameSocket';
import { PostGameProgression } from '../common/PostGameProgression';
import { usePracticeXp } from '../../hooks/usePracticeXp';
import { GamePauseMenu } from '../common/GamePauseMenu';
import { FullscreenButton } from '../common/fullscreen';
import { PerfHud } from '../common/PerfHud';
// "Are you sure? leaving forfeits" — every mid-match exit (pause-menu Quit,
// App-level nav) funnels through this guard: confirm → forfeit → results →
// progression → only then the deferred navigation runs.
import { useGuardedExit } from '../common/exitGuard';
// Shared in-match scoreboard card (the Pug Shooter HUD board).
import { MatchLeaderboard } from '../common/MatchLeaderboard';

interface PingPongGameProps {
  socket: Socket;
  mode: 'multiplayer' | 'computer';
  playerData: { name: string; avatarUrl: string; difficulty?: number; matchMode: 'classic' | 'bestof3' | 'sudden' };
  gameData?: any;
  onExit: () => void;
  settings: { ghostMode: boolean; minimalistMode: boolean };
  wagerAmount?: number;
}

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 500;
const PADDLE_WIDTH = 8;
const PADDLE_HEIGHT = 60;
const PADDLE_OFFSET = 30;
const BALL_SIZE = 12;
const BORDER_OFFSET = 12; // Increased to match visual neon glow
const START_SPEED = 5;
const SPEED_INC = 1.08; // 8% increase per hit
const MAX_SPEED = 18;

const PingPongGame = ({ socket, mode, playerData, gameData, onExit, settings, wagerAmount = 0 }: PingPongGameProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [score, setScore] = useState({ p1: 0, p2: 0 });
  const [gameState, setGameState] = useState<'countdown' | 'playing' | 'ended'>('countdown');
  const [countdown, setCountdown] = useState(3);
  const [winner, setWinner] = useState<string | null>(null);
  // Server-declared result. Preferred over name comparison — two players named
  // 'Player' would otherwise BOTH think they won. null = fall back to names
  // (computer mode, or an old-style volleyEnded without winnerSocketId).
  const [wonMatch, setWonMatch] = useState<boolean | null>(null);
  const { win, balance } = useNeonBucks();
  
  const gameContainerRef = useRef<HTMLDivElement>(null);
  const [endReason, setEndReason] = useState<{ reason: string; details?: string } | null>(null);
  const [rematchStatus, setRematchStatus] = useState<'none' | 'sent' | 'offered'>('none');
  // Per-player "+XP / rank change" from the server, chained post-results.
  const { progression, clear: clearProgression } = useMatchProgression();
  // Practice (vs-AI) twin — self-reported XP, no rank.
  const { practiceProgression, armRound, reportRound, clearPracticeProgression } =
    usePracticeXp('volley');
  /** Once-per-round guard for the end effect below — its deps (iWon,
   *  wagerAmount identity, playEffect) can churn while gameState stays
   *  'ended', and an unguarded body double-paid the practice pot and would
   *  double-fire sounds/XP. Reset when a new rally starts. */
  const endHandledRef = useRef(false);
  
  // Sound FX (Web Audio API for zero latency)
  const audioContext = useRef<AudioContext | null>(null);
  const victoryBuffer = useRef<AudioBuffer | null>(null);
  const resultBuffer = useRef<AudioBuffer | null>(null);

  useEffect(() => {
    // Initialize AudioContext
    audioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)();

    const generateFallbackSound = (isVictory: boolean) => {
      if (!audioContext.current) return null;
      const duration = 1.5;
      const sampleRate = audioContext.current.sampleRate;
      const buffer = audioContext.current.createBuffer(1, sampleRate * duration, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < sampleRate * duration; i++) {
        const t = i / sampleRate;
        // Simple retro synth glide
        const freq = isVictory ? (440 + t * 440) : (440 - t * 220); 
        data[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-2 * t) * 0.3;
      }
      return buffer;
    };

    const loadSound = async (url: string) => {
      try {
        // Try to fetch with relative path to avoid some environment pathing issues
        const response = await fetch(url.startsWith('/') ? url.slice(1) : url);
        if (!response.ok) throw new Error(`Status: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        if (audioContext.current) {
          return await audioContext.current.decodeAudioData(arrayBuffer);
        }
      } catch (err) {
        console.warn(`Could not fetch sound ${url}, using fallback synthesizer:`, err);
        return generateFallbackSound(url.includes('winning'));
      }
      return null;
    };

    const initSounds = async () => {
      victoryBuffer.current = await loadSound('winningresultsoundfx.mp3');
      resultBuffer.current = await loadSound('result.mp3');
    };

    initSounds();

    return () => {
      if (audioContext.current) {
        audioContext.current.close();
      }
    };
  }, []);

  const playEffect = useCallback((isVictory: boolean) => {
    const buffer = isVictory ? victoryBuffer.current : resultBuffer.current;
    if (!audioContext.current || !buffer) return;

    // Resume context if it was suspended (browser policy)
    if (audioContext.current.state === 'suspended') {
      audioContext.current.resume();
    }

    const source = audioContext.current.createBufferSource();
    const gainNode = audioContext.current.createGain();
    
    source.buffer = buffer;
    gainNode.gain.value = 0.6; // Volume
    
    source.connect(gainNode);
    gainNode.connect(audioContext.current.destination);
    
    source.start(0);
  }, []);

  // Did WE win? Server socket-id verdict when available, name compare otherwise.
  const iWon = wonMatch ?? (winner === playerData.name);

  useEffect(() => {
    if (gameState === 'ended') {
      if (endHandledRef.current) return;
      endHandledRef.current = true;
      playEffect(iWon);
      // NEON BUCKS ARE PRACTICE-ONLY. The online path must never call
      // wager()/win() — there is no stake of any kind in an online match.
      if (mode === 'computer' && iWon && wagerAmount > 0) {
        win(wagerAmount * 2);
      }
      // PRACTICE XP — the vs-AI round self-reports (metered server-side)
      // and the award chains the same progression overlay online play gets.
      if (mode === 'computer') {
        reportRound({ result: iWon ? 'win' : 'loss' });
      }
    } else {
      endHandledRef.current = false;
    }
  }, [gameState, iWon, playEffect, mode, wagerAmount, win, reportRound]);

  /**
   * EXIT GUARD — "are you sure? leaving forfeits."
   * A live rally must not be abandoned silently, and the countdown counts:
   * online the server match already exists, practice the stake was already
   * deducted by WagerMenu. Confirming flips the game into its
   * ended-as-a-loss state; the normal results + progression flow plays, and
   * only then the deferred exit runs (finishExit, cued from
   * PostGameProgression's onDone below).
   */
  const { requestExit, finishExit, abortPendingExit, confirmOpen, confirmDialog } = useGuardedExit({
    active: gameState !== 'ended',
    onForfeit: () => {
      if (mode === 'multiplayer') {
        if (gameData?.gameId) {
          // BARE gameId string — the server's expected payload shape. The
          // server ends the game for the whole room (resigner included):
          // because we stay mounted, 'volleyEnded' and 'match:progression'
          // still reach us and the results + progression screens play out.
          // Settlement is entirely server-side (eloSettled guard) — this
          // emit is the ONLY thing the client does.
          socket.emit('volleyResign', gameData.gameId);
          return 'wait';
        }
        // No live server game to resign (should be unreachable while
        // playing) — nothing will ever arrive, so just leave.
        return 'immediate';
      }
      // PRACTICE: end the round as a resignation loss. The end effect above
      // then reports the loss exactly once (endHandledRef + usePracticeXp's
      // own guard), the results screen shows the defeat with a forfeit
      // note, and the practice XP overlay chains after it.
      setGameState('ended');
      setWinner('Neural Net AI');
      setEndReason({ reason: 'resignation' });
      return 'wait';
    },
    copy: () =>
      mode === 'multiplayer'
        ? {
            message:
              'Leaving now resigns the match — your opponent takes the win. Your results and progression will play before you go.',
            confirmLabel: 'Resign & leave',
          }
        : {
            message:
              'Leaving now ends the practice match as a loss and forfeits your wager. Your results will play before you go.',
          },
  });

  const WINNING_SCORE = playerData.matchMode === 'classic' ? 11 : (playerData.matchMode === 'bestof3' ? 2 : 1);

  // Countdown Logic
  useEffect(() => {
    if (gameState === 'countdown') {
      const timer = setInterval(() => {
        setCountdown(c => {
          if (c <= 1) {
            clearInterval(timer);
            setGameState('playing');
            return 0;
          }
          return c - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [gameState]);

  
  // Local state for animation
  const ballPos = useRef({ x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 });
  const ballVel = useRef({ x: START_SPEED, y: START_SPEED });
  const paddle1Y = useRef(CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2);
  const paddle2Y = useRef(CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2);
  const trailRef = useRef<{ x: number, y: number }[]>([]);
  
  const isP1 = useRef(mode === 'computer' || (gameData && gameData.p1 && socket.id === gameData.p1.socketId));
  const opponent = useRef(mode === 'computer' ? { 
    name: 'Neural Net AI' 
  } : (isP1.current ? (gameData?.p2 || { name: 'Opponent', avatarUrl: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Opp' }) : (gameData?.p1 || { name: 'Opponent', avatarUrl: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Opp' })));

  const resetBall = useCallback(() => {
    ballPos.current = { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
    ballVel.current = { 
      x: (Math.random() > 0.5 ? 1 : -1) * START_SPEED, 
      y: (Math.random() > 0.5 ? 1 : -1) * (START_SPEED * 0.8) 
    };
  }, []);

  // Game Loop
  useEffect(() => {
    if (gameState !== 'playing') return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;

    const update = () => {
      if (mode === 'computer') {
        // --- PHYSICS (Single Player / AI) ---
        ballPos.current.x += ballVel.current.x;
        ballPos.current.y += ballVel.current.y;

        // Wall collisions
        const effectiveBorder = BORDER_OFFSET + 4;
        if (ballPos.current.y <= effectiveBorder) {
          ballVel.current.y = Math.abs(ballVel.current.y);
          ballPos.current.y = effectiveBorder;
        } else if (ballPos.current.y >= CANVAS_HEIGHT - BALL_SIZE - effectiveBorder) {
          ballVel.current.y = -Math.abs(ballVel.current.y);
          ballPos.current.y = CANVAS_HEIGHT - BALL_SIZE - effectiveBorder;
        }

        // Paddle 1 collision (Left - Player)
        const pLimit = BORDER_OFFSET + 5;
        if (ballPos.current.x <= PADDLE_OFFSET + PADDLE_WIDTH) {
          if (ballPos.current.y + BALL_SIZE >= paddle1Y.current && ballPos.current.y <= paddle1Y.current + PADDLE_HEIGHT) {
            // Speed up and reverse
            ballVel.current.x = Math.abs(ballVel.current.x) * SPEED_INC;
            ballVel.current.y *= SPEED_INC;
            
            // Limit speed
            if (Math.abs(ballVel.current.x) > MAX_SPEED) ballVel.current.x = Math.sign(ballVel.current.x) * MAX_SPEED;
            if (Math.abs(ballVel.current.y) > MAX_SPEED) ballVel.current.y = Math.sign(ballVel.current.y) * MAX_SPEED;

            // Add vertical variance based on where it hit the paddle
            const deltaY = ballPos.current.y - (paddle1Y.current + PADDLE_HEIGHT / 2);
            ballVel.current.y += deltaY * 0.2;
            ballPos.current.x = PADDLE_OFFSET + PADDLE_WIDTH;
          } else if (ballPos.current.x < 0) {
            setScore(s => {
              const newScore = { ...s, p2: s.p2 + 1 };
              if (newScore.p2 >= WINNING_SCORE) {
                setGameState('ended');
                setWinner('Neural Net AI');
              }
              resetBall();
              return newScore;
            });
          }
        }

        // Paddle 2 collision (Right - AI)
        if (ballPos.current.x >= CANVAS_WIDTH - PADDLE_WIDTH - BALL_SIZE - PADDLE_OFFSET) {
          if (ballPos.current.y + BALL_SIZE >= paddle2Y.current && ballPos.current.y <= paddle2Y.current + PADDLE_HEIGHT) {
            // Speed up and reverse
            ballVel.current.x = -Math.abs(ballVel.current.x) * SPEED_INC;
            ballVel.current.y *= SPEED_INC;

            // Limit speed
            if (Math.abs(ballVel.current.x) > MAX_SPEED) ballVel.current.x = Math.sign(ballVel.current.x) * MAX_SPEED;
            if (Math.abs(ballVel.current.y) > MAX_SPEED) ballVel.current.y = Math.sign(ballVel.current.y) * MAX_SPEED;

            const deltaY = ballPos.current.y - (paddle2Y.current + PADDLE_HEIGHT / 2);
            ballVel.current.y += deltaY * 0.2;
            ballPos.current.x = CANVAS_WIDTH - PADDLE_WIDTH - BALL_SIZE - PADDLE_OFFSET;
          } else if (ballPos.current.x > CANVAS_WIDTH) {
            setScore(s => {
              const newScore = { ...s, p1: s.p1 + 1 };
              if (newScore.p1 >= WINNING_SCORE) {
                setGameState('ended');
                setWinner(playerData.name);
              }
              resetBall();
              return newScore;
            });
          }
        }

        // --- AI LOGIC ---
        const aiSpeed = 3 + (playerData.difficulty || 3);
        const targetY = ballPos.current.y - PADDLE_HEIGHT / 2;
        if (paddle2Y.current < targetY) {
          paddle2Y.current += Math.min(aiSpeed, targetY - paddle2Y.current);
        } else if (paddle2Y.current > targetY) {
          paddle2Y.current -= Math.min(aiSpeed, paddle2Y.current - targetY);
        }
        // Clamp AI paddle
        paddle2Y.current = Math.max(pLimit, Math.min(CANVAS_HEIGHT - PADDLE_HEIGHT - pLimit, paddle2Y.current));
      } else {
        // --- MULTIPLAYER MODE ---
        // In multiplayer, we might sync from server or let one client be authoritative.
        // For simplicity, we'll listen to socket events.
      }
    };

    const drawBorder = (ctx: CanvasRenderingContext2D) => {
      ctx.strokeStyle = '#00FFD1';
      ctx.shadowColor = '#00FFD1';

      // Draw exactly at match boundaries
      const offset = BORDER_OFFSET;
      const w = CANVAS_WIDTH - offset * 2;
      const h = CANVAS_HEIGHT - offset * 2;

      // Outer glow (wide and soft)
      ctx.lineWidth = 6;
      ctx.shadowBlur = 40;
      ctx.strokeRect(offset, offset, w, h);

      // Inner glow (tight and bright)
      ctx.lineWidth = 3;
      ctx.shadowBlur = 15;
      ctx.strokeRect(offset, offset, w, h);

      ctx.shadowBlur = 0; // always reset after
    };

    const draw = () => {
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Update and Draw Trail
      trailRef.current.push({ x: ballPos.current.x + BALL_SIZE / 2, y: ballPos.current.y + BALL_SIZE / 2 });
      if (trailRef.current.length > 20) trailRef.current.shift();

      trailRef.current.forEach((pos, i) => {
        const progress = i / trailRef.current.length;
        
        // Shift towards target #00FFD1 (0, 255, 209)
        const r = Math.floor(progress * 0);
        const g = Math.floor(progress * 255);
        const b = Math.floor(progress * 209);
        const alpha = progress * 0.6;

        ctx.beginPath();
        ctx.arc(pos.x, pos.y, progress * (BALL_SIZE / 2), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        ctx.fill();
      });

      // Draw dashed center line
      ctx.setLineDash([10, 10]);
      ctx.strokeStyle = 'rgba(0, 255, 209, 0.2)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(CANVAS_WIDTH / 2, 0);
      ctx.lineTo(CANVAS_WIDTH / 2, CANVAS_HEIGHT);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw Paddles with neon effects
      ctx.fillStyle = '#00FFD1';
      ctx.shadowBlur = 15;
      ctx.shadowColor = '#00FFD1';
      
      // Paddle 1
      ctx.beginPath();
      ctx.roundRect(PADDLE_OFFSET, paddle1Y.current, PADDLE_WIDTH, PADDLE_HEIGHT, 5);
      ctx.fill();

      // Paddle 2
      ctx.beginPath();
      ctx.roundRect(CANVAS_WIDTH - PADDLE_WIDTH - PADDLE_OFFSET, paddle2Y.current, PADDLE_WIDTH, PADDLE_HEIGHT, 5);
      ctx.fill();

      // Draw Ball
      ctx.beginPath();
      ctx.arc(ballPos.current.x + BALL_SIZE / 2, ballPos.current.y + BALL_SIZE / 2, BALL_SIZE / 2, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.shadowBlur = 0; // Reset shadow

      // Draw neon border
      drawBorder(ctx);
    };

    const render = () => {
      // Menu open in practice = frozen sim, still-drawn frame underneath.
      if (!(menuPausedRef.current && mode === 'computer')) update();
      draw();
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => cancelAnimationFrame(animationFrameId);
  }, [gameState, mode, resetBall, playerData.name, playerData.difficulty]);

  // Handle Input
  useEffect(() => {

    /**
     * POINTER events, not mouse events. `pointermove` fires for a mouse, a
     * finger and a stylus alike, so this one handler makes the paddle work on
     * a phone — before, the paddle listened only for `mousemove` and touching
     * the screen did literally nothing, which is what made Volley unplayable
     * on mobile.
     */
    const handlePointerMove = (e: PointerEvent) => {
      if (gameState !== 'playing') return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      let newY: number;

      // Use Pointer Lock relative movement if available
      if (document.pointerLockElement === canvas) {
        newY = (isP1.current ? paddle1Y.current : paddle2Y.current) + e.movementY;
      } else {
        const rect = canvas.getBoundingClientRect();
        // SCALE from CSS pixels into canvas space. The canvas is 500 units
        // tall but is laid out at whatever height the stage gives it, so
        // subtracting rect.top alone put the paddle at the wrong place
        // wherever the two differ — the taller the display, the further the
        // paddle lagged behind the finger. Guard against a zero-height rect
        // (possible for one frame during fullscreen transitions).
        const scale = rect.height > 0 ? CANVAS_HEIGHT / rect.height : 1;
        const pointerY = (e.clientY - rect.top) * scale;
        newY = pointerY - PADDLE_HEIGHT / 2;
      }

      const limitedY = Math.max(BORDER_OFFSET, Math.min(CANVAS_HEIGHT - PADDLE_HEIGHT - BORDER_OFFSET, newY));
      
      if (isP1.current) {
        if (paddle1Y.current !== limitedY) {
          paddle1Y.current = limitedY;
          if (mode === 'multiplayer') {
            socket.emit('movePaddle', { gameId: gameData.gameId, paddleY: limitedY, player: 'p1' });
          }
        }
      } else {
        if (paddle2Y.current !== limitedY) {
          paddle2Y.current = limitedY;
          if (mode === 'multiplayer') {
            socket.emit('movePaddle', { gameId: gameData.gameId, paddleY: limitedY, player: 'p2' });
          }
        }
      }
    };

    /**
     * Pointer lock is a mouse-only idea — it hides the cursor and reports
     * relative movement. On a touchscreen there is no cursor to lock, the
     * request rejects (an unhandled promise rejection in some browsers), and
     * if it somehow succeeded it would break absolute finger tracking, which
     * is the ONLY way to aim a paddle with a thumb. So: pointer devices only.
     */
    const canLockPointer =
      typeof window !== 'undefined' &&
      window.matchMedia('(pointer: fine)').matches;

    const handleCanvasClick = () => {
      if (canLockPointer && gameState === 'playing' && canvasRef.current) {
        void canvasRef.current.requestPointerLock();
      }
    };

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.addEventListener('click', handleCanvasClick);
    }

    window.addEventListener('pointermove', handlePointerMove);
    // A finger that lands and holds without moving should still place the
    // paddle — pointermove alone would wait for the first drag pixel.
    window.addEventListener('pointerdown', handlePointerMove);

    // Automatically try to lock when game starts
    if (canLockPointer && gameState === 'playing' && canvas) {
      void canvas.requestPointerLock();
    }

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerdown', handlePointerMove);
      if (canvas) {
        canvas.removeEventListener('click', handleCanvasClick);
      }
      if (document.pointerLockElement === canvas) {
        document.exitPointerLock();
      }
    };
  }, [gameState, mode, gameData, socket]);

  // Multiplayer Sync — named handlers + handler-specific socket.off: the
  // socket is the SHARED game singleton, so blanket .off('event') would strip
  // listeners belonging to other components too.
  useEffect(() => {
    if (mode !== 'multiplayer') return;

    const onVolleyUpdate = (data: any) => {
      ballPos.current = data.ballPos;
      if (isP1.current) {
        paddle2Y.current = data.paddle2Y;
      } else {
        paddle1Y.current = data.paddle1Y;
      }
      setScore(data.score);
    };

    const onVolleyEnded = (data: any) => {
      setGameState('ended');
      setWinner(data.winner);
      // Prefer the server's socket-id verdict; fall back to display-name
      // comparison for backward compatibility.
      setWonMatch(
        typeof data.winnerSocketId === 'string'
          ? data.winnerSocketId === socket.id
          : null
      );
      setEndReason({ reason: data.reason, details: data.details });
    };

    const onRematchOffered = () => {
      setRematchStatus('offered');
    };

    const onVolleyGameReset = (data: any) => {
      setScore(data.score);
      setGameState('playing');
      setWinner(null);
      setWonMatch(null);
      setEndReason(null);
      setRematchStatus('none');
      ballPos.current = data.ballPos;
      // A rematch inside the progression overlay's lead-in must not let the
      // LAST rally's "+XP / RANKED UP" play over the fresh one.
      clearProgression();
      // A server-confirmed rematch while a forfeit-exit was pending means
      // the player changed their mind — drop the deferred navigation.
      abortPendingExit();
    };

    socket.on('volleyUpdate', onVolleyUpdate);
    socket.on('volleyEnded', onVolleyEnded);
    socket.on('rematchOffered', onRematchOffered);
    socket.on('volleyGameReset', onVolleyGameReset);

    return () => {
      socket.off('volleyUpdate', onVolleyUpdate);
      socket.off('volleyEnded', onVolleyEnded);
      socket.off('rematchOffered', onRematchOffered);
      socket.off('volleyGameReset', onVolleyGameReset);
    };
  }, [mode, socket, isP1]);

  const handleRematchRequest = () => {
    // Rematch while a forfeit-exit is pending = "I changed my mind" — drop
    // the deferred navigation before the new rally starts.
    abortPendingExit();
    if (mode === 'computer') {
      setScore({ p1: 0, p2: 0 });
      setGameState('playing');
      setWinner(null);
      setWonMatch(null);
      setEndReason(null);
      setRematchStatus('none');
      resetBall();
      // New rally: re-arm the once-per-round guards and drop any overlay
      // payload still queued from the last one.
      armRound();
      clearPracticeProgression();
      clearProgression();
      return;
    }
    setRematchStatus('sent');
    socket.emit('volleyRequestRematch', gameData?.gameId);
  };

  /**
   * Leaving the screen — routed through the exit guard. Mid-match (the guard
   * is active) it confirms first; on confirm, onForfeit resigns online (the
   * server would otherwise keep the opponent rallying against a frozen
   * paddle) or ends the practice round as a loss, the results + progression
   * screens play, and only THEN onExit runs. From the results screen the
   * guard is inactive ('ended'), so this exits immediately — the old
   * handleResign's stay-and-show-results behavior, finally wired to a button.
   */
  const handleExitMatch = useCallback(() => {
    requestExit(onExit);
  }, [requestExit, onExit]);

  /**
   * TAB-HELD SCOREBOARD — the Pug Shooter pattern that actually fits here.
   *
   * Pug Shooter has TWO boards: an always-on HUD card and a Tab-held card.
   * Only the second one works in Volley. Its court is a centred aspect-[2/1]
   * canvas as wide as the viewport, so it has no margins to put a card in:
   * every fixed corner lands on the playfield, and which part it ruins just
   * moves around with the window (bottom-left covers the paddle, top-left
   * covers the ball's run along the top wall, and past a 2:1 viewport the
   * court letterboxes horizontally and slides the paddle under a left-hand
   * card again). Held-on-demand is the only placement that can never occlude
   * a rally — the player asks for it, and play is theirs to pause.
   *
   * Discoverability is the hint below rather than an auto-show: a card
   * popped over the 3-2-1 would land squarely on the countdown numeral.
   */
  const [boardHeld, setBoardHeld] = useState(false);
  /**
   * PRACTICE FREEZE. Opening the menu must actually PAUSE a practice rally —
   * the sim used to keep playing (and scoring) under the overlay. A ref so
   * the render-loop effect (keyed on gameState/mode) reads it without
   * re-running; multiplayer never pauses (the server owns that clock).
   */
  const menuPausedRef = useRef(false);
  // Swallowing Tab is only ever legitimate DURING A RALLY. Any modal above
  // the game — the forfeit confirm, the pause menu, the results screen —
  // needs Tab for its own buttons, and while a Volley match is mounted the
  // pause pill is the only focusable way out, so eating Tab there would trap
  // a keyboard user with no exit. Refs, so the listener binds once.
  const boardGateRef = useRef({ playing: false, modal: false });
  const [pauseOpen, setPauseOpen] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
      const gate = boardGateRef.current;
      if (!gate.playing || gate.modal) return; // let focus move normally
      e.preventDefault(); // Tab would otherwise walk the arcade's focus ring
      setBoardHeld(true);
    };
    // `up` and `blur` only ever CLEAR, so they stay unconditional — a board
    // stuck open because its release was gated would be the worse bug.
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Tab') setBoardHeld(false);
    };
    const blur = () => setBoardHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // In-match leaderboard rows: my side vs theirs, leader on top (the sort is
  // stable, so a tie keeps my row first). Score halves map through isP1 —
  // p1 is the LEFT paddle, not necessarily me in an online match.
  const myScore = isP1.current ? score.p1 : score.p2;
  const theirScore = isP1.current ? score.p2 : score.p1;
  const leaderboardRows = [
    { name: playerData.name, value: myScore, isPlayer: true },
    { name: String(opponent.current.name ?? 'Opponent'), value: theirScore },
  ].sort((a, b) => b.value - a.value);

  // Keep the Tab gate current: hold the board only during a live rally with
  // nothing modal on top of it.
  boardGateRef.current = {
    playing: gameState === 'playing',
    modal: confirmOpen || pauseOpen,
  };

  return (
    <div 
      ref={gameContainerRef}
      /* h-[100dvh]: `h-screen` is 100vh, which on mobile browsers measures the
         viewport with the URL bar hidden — so the bottom-anchored controls
         and the exit button sat underneath the browser chrome until the user
         scrolled, which this container forbids. touch-none stops the whole
         stage from being treated as a scrollable page during a rally. */
      className={`flex flex-col items-center justify-center h-[100dvh] w-screen bg-[#081616] font-body relative overflow-hidden touch-none ${gameState === 'playing' ? 'cursor-none' : ''}`}
    >
      {/* HUD - Redesigned to be more immersive and centered */}
      {!settings.minimalistMode && (
        <div className={`absolute top-0 left-0 right-0 z-20 p-4 sm:p-8 pt-[max(1rem,env(safe-area-inset-top))] flex justify-between items-start gap-2 pointer-events-none transition-opacity duration-500 ${settings.ghostMode ? 'opacity-0 hover:opacity-100' : 'opacity-100'}`}>
          {/* Player 1 - Left */}
          {!settings.ghostMode && (
            <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-full border-2 border-[#00FFD1]/50 bg-[#00FFD1]/10 overflow-hidden shadow-[0_0_20px_rgba(0,255,209,0.3)]">
                  <img src={playerData.avatarUrl} alt="Me" className="w-full h-full object-cover" />
                </div>
                <div className="hidden sm:block">
                  <p className="text-white font-black tracking-widest uppercase text-base italic">{playerData.name}</p>
                </div>
            </div>
          )}

          {/* Centered Score */}
          <div className="flex flex-col items-center mx-auto translate-x-[-50%] absolute left-1/2">
              {!settings.ghostMode && (
                <div className="text-[8px] sm:text-[10px] font-mono tracking-[0.3em] sm:tracking-[0.5em] uppercase text-[#00FFD1] mb-2 font-bold opacity-60 text-center w-40 sm:w-64">
                  {playerData.matchMode === 'classic' ? 'Match to 11' : playerData.matchMode === 'bestof3' ? 'Best of Three' : 'Sudden Death'}
                </div>
              )}
              <div className="flex items-center gap-10">
                <div className="flex flex-col items-center">
                    <span className="text-4xl sm:text-6xl md:text-7xl font-black text-white italic drop-shadow-[0_0_30px_rgba(255,255,255,0.4)] leading-none">{score.p1}</span>
                    <div className="flex gap-2 mt-4 items-center w-full">
                        {[...Array(playerData.matchMode === 'bestof3' ? 3 : WINNING_SCORE)].map((_, i) => (
                          <div 
                            key={i} 
                            className={`transition-all duration-500 rounded-sm ${i < score.p1 ? 'bg-[#00FFD1] shadow-[0_0_12px_#00FFD1]' : 'bg-white/10'}`} 
                            style={{ 
                              flex: i === 2 && playerData.matchMode === 'bestof3' ? 2 : 1, // Sudden death slot is bigger
                              height: (i === 2 && playerData.matchMode === 'bestof3') ? '8px' : (playerData.matchMode === 'bestof3' ? '5px' : '3px')
                            }} 
                          />
                        ))}
                    </div>
                </div>
                <span className="text-2xl text-[#00FFD1] font-black italic opacity-40">/</span>
                <div className="flex flex-col items-center">
                    <span className="text-4xl sm:text-6xl md:text-7xl font-black text-white italic drop-shadow-[0_0_30px_rgba(255,255,255,0.4)] leading-none">{score.p2}</span>
                    <div className="flex gap-2 mt-4 items-center w-full flex-row-reverse">
                        {[...Array(playerData.matchMode === 'bestof3' ? 3 : WINNING_SCORE)].map((_, i) => (
                          <div 
                            key={i} 
                            className={`transition-all duration-500 rounded-sm ${i < score.p2 ? 'bg-[#00FFD1] shadow-[0_0_12px_#00FFD1]' : 'bg-white/10'}`} 
                            style={{ 
                              flex: i === 2 && playerData.matchMode === 'bestof3' ? 2 : 1, // Sudden death slot is bigger
                              height: (i === 2 && playerData.matchMode === 'bestof3') ? '8px' : (playerData.matchMode === 'bestof3' ? '5px' : '3px')
                            }} 
                          />
                        ))}
                    </div>
                </div>
              </div>
          </div>

          {/* Player 2 - Right */}
          {!settings.ghostMode && (
            <div className="flex items-center gap-4 text-right ml-auto">
                <div className="hidden sm:block">
                  <p className="text-white font-black tracking-widest uppercase text-base italic">{opponent.current.name}</p>
                </div>
                <div className="w-14 h-14 rounded-full border-2 border-white/20 bg-white/5 flex items-center justify-center shadow-[0_0_20px_rgba(255,255,255,0.1)] overflow-hidden">
                  {opponent.current.avatarUrl ? (
                      <img src={opponent.current.avatarUrl} alt="Opponent" className="w-full h-full object-cover" />
                  ) : (
                      <Zap className="text-white/40" />
                  )}
                </div>
            </div>
          )}
        </div>
      )}

      {/* IN-MATCH LEADERBOARD — held on Tab, centred like Pug Shooter's own
          Tab scoreboard. See the boardHeld comment above for why an always-on
          card cannot work over this court. Minimalist mode hides it like the
          rest of the HUD; the results screen owns the 'ended' moment. */}
      {!settings.minimalistMode && gameState !== 'ended' && boardHeld && (
        <MatchLeaderboard
          rows={leaderboardRows}
          valueLabel="PTS"
          className="absolute left-1/2 top-1/2 w-64 -translate-x-1/2 -translate-y-1/2 z-[70] pointer-events-none"
        />
      )}

      {/* The keybind, said once where the other control hints live — a board
          nobody knows to hold for may as well not exist. */}
      {!settings.minimalistMode && gameState === 'playing' && !boardHeld && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 font-mono text-[9px] uppercase tracking-[0.3em] text-white/25 pointer-coarse:hidden">
          Hold Tab — Scores
        </div>
      )}

      {/* FPS/ping — the top-right corner itself belongs to the opponent
          block in the HUD strip above, so this sits just under it. */}
      <PerfHud positionClassName="absolute top-24 right-4 sm:right-8 z-30" />

      {/* Fullscreen — bottom-right like every game. Desktop-only by
          construction (null on coarse pointers), so it never collides with
          the touch Menu pill in this corner; same document toggle as the
          global 'f' keybind and the pause menu's ghost action. */}
      <FullscreenButton positionClassName="absolute bottom-8 right-8 z-[60]" />

      {/* Game Stage */}
      <div className="relative w-full h-full flex items-center justify-center bg-radial-gradient">
          <div className="absolute inset-0 bg-[#00FFD1]/5 opacity-20" style={{ backgroundImage: 'radial-gradient(circle at center, #00FFD1 0%, transparent 70%)' }} />
          {/*
            aspect-[2/1] + object-contain, NOT `w-full h-full object-fill`.
            The play field is 1000x500; stretching it to fill a 390x844
            portrait viewport squashed it to roughly 1:2, so the ball moved
            visibly faster horizontally than vertically and the paddle covered
            a different fraction of the court than the physics thought it did.
            Letterboxing preserves the 2:1 court on every screen, and because
            the pointer handler scales through getBoundingClientRect it stays
            in sync automatically.

            touch-none (touch-action: none) is what makes dragging actually
            control the paddle: without it the browser claims the gesture as a
            page scroll / pull-to-refresh and the pointermove stream stops
            after a few pixels.
          */}
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className="bg-[#0b1a1a] shadow-[0_0_100px_rgba(0,255,209,0.3)] relative z-10 cursor-none w-full h-auto max-h-full aspect-[2/1] object-contain touch-none select-none border-[#00FFD1]/20"
          />

          {/* Countdown Overlay */}
          <AnimatePresence>
            {gameState === 'countdown' && (
              <motion.div
                initial={{ opacity: 0, scale: 2 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 5 }}
                key={countdown}
                className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none"
              >
                <span className="text-[200px] font-black text-[#00FFD1] italic drop-shadow-[0_0_50px_#00FFD1]">
                  {countdown}
                </span>
              </motion.div>
            )}
          </AnimatePresence>

         
         <AnimatePresence>
            {gameState === 'ended' && (
              <ResultsScreen
                won={iWon}
                // NO MONEY ONLINE: stake/winnings are practice-mode Neon Bucks
                // only — the online path never wagers, so both read zero.
                stake={mode === 'computer' ? wagerAmount : 0}
                winnings={mode === 'computer' ? (iWon ? wagerAmount * 2 : 0) : 0}
                gameMode={mode === 'computer' ? 'Practice' : 'Online'}
                // Online stakes nothing — hide the Wagered/Payout rows.
                moneyless={mode !== 'computer'}
                // Server end reasons finally reach the player: a forfeit win
                // ("Opponent disconnected") or a resignation is said out
                // loud instead of living in never-rendered state.
                note={
                  endReason?.reason === 'disconnect'
                    ? 'Your opponent left the game — you win by forfeit'
                    : endReason?.reason === 'resignation'
                      ? iWon
                        ? 'Your opponent resigned — you win'
                        // The resigner is the loser by construction (server
                        // rule online, onForfeit locally) — so this is OUR
                        // forfeit-on-exit, said out loud.
                        : 'You left the match — counted as a loss'
                      : endReason?.details ?? null
                }
                onRematch={handleRematchRequest}
                onExit={handleExitMatch}
              />
            )}
         </AnimatePresence>

         {/* Level/rank progression, chained after the results screen. When a
             forfeit-exit is pending, its close is the cue to finally run the
             deferred navigation (finishExit is a no-op otherwise). */}
         <PostGameProgression
           progression={progression ?? practiceProgression}
           onDone={() => {
             clearProgression();
             clearPracticeProgression();
             finishExit();
           }}
         />
      </div>

      {!settings.minimalistMode && (
        <p className="fixed bottom-24 sm:bottom-8 left-1/2 -translate-x-1/2 w-full px-4 text-center text-[#00FFD1]/40 font-mono text-[9px] sm:text-[10px] tracking-[0.3em] sm:tracking-[0.4em] uppercase z-20 pointer-events-none">
           {/* Keyed on POINTER TYPE, not width — telling a phone user to "use
               mouse" is worse than saying nothing, and a narrow desktop
               window still has a mouse. */}
           <span className="pointer-coarse:hidden">Use mouse for vertical deflection</span>
           <span className="hidden pointer-coarse:inline">Drag to move your paddle</span>
        </p>
      )}

      {/* Floating Controls - Styled like Asteroids */}
      {/* THE exit path: shared pug-style pause menu (Resume / Fullscreen (F)
          / Exit). Replaces the floating back button and the standalone
          fullscreen button. Exiting online mid-match resigns first
          (handleExitMatch), exactly as the back button did. */}
      {/* onOpenChange feeds the Tab gate: while this menu is up, Tab must
          reach its own buttons instead of holding the scoreboard. */}
      <GamePauseMenu
        onExit={handleExitMatch}
        exitLabel="Exit Game"
        onOpenChange={(open) => {
          setPauseOpen(open);
          menuPausedRef.current = open;
        }}
      />
      <div className="absolute bottom-4 sm:bottom-8 right-4 sm:right-8 mb-[env(safe-area-inset-bottom)] flex gap-3 pointer-events-auto z-[60]">
      </div>

      {/* Mid-match "are you sure? leaving forfeits" dialog — z-[130], above
          the pause menu (125) so it always wins the argument. The hook exits
          pointer lock when it opens, and nothing re-locks while it is up:
          the canvas click-to-lock handler can't fire through the overlay,
          and the auto-lock effect only re-runs on state changes the dialog
          doesn't cause. */}
      {confirmDialog}
    </div>
  );
};

export default PingPongGame;
