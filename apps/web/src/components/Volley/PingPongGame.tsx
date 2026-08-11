import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, Trophy, User, Zap, Maximize2 } from 'lucide-react';
import GameBackButton from '../common/GameBackButton';
import { ResultsScreen } from '../NeonBucks/ResultsScreen';
import { useNeonBucks } from '../../NeonBucksStore';

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
      playEffect(iWon);
      if (mode === 'computer' && iWon && wagerAmount > 0) {
        win(wagerAmount * 2);
      }
    }
  }, [gameState, iWon, playEffect, mode, wagerAmount, win]);

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

  // Fullscreen toggle
  const toggleFullscreen = () => {
    if (!gameContainerRef.current) return;
    if (!document.fullscreenElement) {
      gameContainerRef.current.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };
  
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
      update();
      draw();
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => cancelAnimationFrame(animationFrameId);
  }, [gameState, mode, resetBall, playerData.name, playerData.difficulty]);

  // Handle Input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'f') {
        toggleFullscreen();
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (gameState !== 'playing') return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      let newY: number;
      
      // Use Pointer Lock relative movement if available
      if (document.pointerLockElement === canvas) {
        newY = (isP1.current ? paddle1Y.current : paddle2Y.current) + e.movementY;
      } else {
        const rect = canvas.getBoundingClientRect();
        const mouseY = e.clientY - rect.top;
        newY = mouseY - PADDLE_HEIGHT / 2;
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

    const handleCanvasClick = () => {
      if (gameState === 'playing' && canvasRef.current) {
        canvasRef.current.requestPointerLock();
      }
    };

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.addEventListener('click', handleCanvasClick);
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('keydown', handleKeyDown);
    
    // Automatically try to lock when game starts
    if (gameState === 'playing' && canvas) {
      canvas.requestPointerLock();
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('keydown', handleKeyDown);
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
    if (mode === 'computer') {
      setScore({ p1: 0, p2: 0 });
      setGameState('playing');
      setWinner(null);
      setWonMatch(null);
      setEndReason(null);
      setRematchStatus('none');
      resetBall();
      return;
    }
    setRematchStatus('sent');
    socket.emit('volleyRequestRematch', gameData?.gameId);
  };

  const handleResign = useCallback(() => {
    if (mode === 'multiplayer' && gameState === 'playing') {
      socket.emit('volleyResign', gameData?.gameId);
    } else if (mode === 'computer' && gameState === 'playing') {
      setGameState('ended');
      setWinner('Neural Net AI');
      setEndReason({ reason: 'resignation' });
    }
  }, [mode, gameState, gameData, socket]);

  return (
    <div 
      ref={gameContainerRef}
      className={`flex flex-col items-center justify-center h-screen w-screen bg-[#081616] font-body relative overflow-hidden ${gameState === 'playing' ? 'cursor-none' : ''}`}
    >
      {/* HUD - Redesigned to be more immersive and centered */}
      {!settings.minimalistMode && (
        <div className={`absolute top-0 left-0 right-0 z-20 p-8 flex justify-between items-start pointer-events-none transition-opacity duration-500 ${settings.ghostMode ? 'opacity-0 hover:opacity-100' : 'opacity-100'}`}>
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
                <div className="text-[10px] font-mono tracking-[0.5em] uppercase text-[#00FFD1] mb-2 font-bold opacity-60 text-center w-64">
                  {playerData.matchMode === 'classic' ? 'Match to 11' : playerData.matchMode === 'bestof3' ? 'Best of Three' : 'Sudden Death'}
                </div>
              )}
              <div className="flex items-center gap-10">
                <div className="flex flex-col items-center">
                    <span className="text-7xl font-black text-white italic drop-shadow-[0_0_30px_rgba(255,255,255,0.4)] leading-none">{score.p1}</span>
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
                    <span className="text-7xl font-black text-white italic drop-shadow-[0_0_30px_rgba(255,255,255,0.4)] leading-none">{score.p2}</span>
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

      {/* Game Stage */}
      <div className="relative w-full h-full flex items-center justify-center bg-radial-gradient">
          <div className="absolute inset-0 bg-[#00FFD1]/5 opacity-20" style={{ backgroundImage: 'radial-gradient(circle at center, #00FFD1 0%, transparent 70%)' }} />
          <canvas 
            ref={canvasRef} 
            width={CANVAS_WIDTH} 
            height={CANVAS_HEIGHT} 
            className="bg-[#0b1a1a] shadow-[0_0_100px_rgba(0,255,209,0.3)] relative z-10 cursor-none w-full h-full object-fill border-[#00FFD1]/20"
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
                stake={mode === 'computer' ? wagerAmount : 0}
                winnings={mode === 'computer' ? (iWon ? wagerAmount * 2 : 0) : 0}
                gameMode={mode === 'computer' ? 'Practice' : 'Online'}
                onRematch={handleRematchRequest}
                onExit={onExit}
              />
            )}
         </AnimatePresence>
      </div>

      {!settings.minimalistMode && (
        <p className="fixed bottom-8 left-1/2 -translate-x-1/2 text-[#00FFD1]/40 font-mono text-[10px] tracking-[0.4em] uppercase z-20 pointer-events-none">
           USE MOUSE FOR VERTICAL DEFLECTION
        </p>
      )}

      {/* Floating Controls - Styled like Asteroids */}
      <GameBackButton onClick={onExit} title="Exit Game" positionClassName="absolute bottom-8 left-8 z-[60] pointer-events-auto" />
      <div className="absolute bottom-8 right-8 flex gap-3 pointer-events-auto z-[60]">
        <button 
          onClick={toggleFullscreen}
          className="p-4 bg-white/5 border border-white/10 rounded-2xl text-[#00FFD1] hover:bg-[#00FFD1]/10 transition-all shadow-2xl active:scale-95"
          title="Toggle Fullscreen"
        >
          <Maximize2 className="w-6 h-6" />
        </button>
      </div>
    </div>
  );
};

export default PingPongGame;
