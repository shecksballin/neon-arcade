import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
// (Brain dropped with the old "Scanning Neural Grid" block — the shared
// SearchingForMatch screen owns that visual now.)
import { Trophy, Timer, Maximize2, Zap, Target, Info } from 'lucide-react';
import GameBackButton from '../common/GameBackButton';
// The one matchmaking screen every online game shows while queued.
import { SearchingForMatch } from '../common/SearchingForMatch';
import { Question } from './TriviaQuestions';
import { Socket } from 'socket.io-client';
import { ResultsScreen } from '../NeonBucks/ResultsScreen';
// The per-player "+XP / rank change" event, chained after the results screen.
import { PostGameProgression } from '../common/PostGameProgression';
import { useMatchProgression } from '../../hooks/useGameSocket';
import { usePracticeXp } from '../../hooks/usePracticeXp';
import { useNeonBucks } from '../../NeonBucksStore';

interface TriviaGameProps {
  mode: 'practice' | 'multiplayer';
  config: { mode: '1v1' | 'ffa' };
  practiceQuestions?: Question[];
  topicName?: string;
  onExit: () => void;
  profile: any;
  socket?: Socket;
  wagerAmount?: number;
}

const TriviaGame = ({ mode, config, practiceQuestions, topicName, onExit, profile, socket, wagerAmount = 0 }: TriviaGameProps) => {
  const [gameState, setGameState] = useState<'waiting' | 'countdown' | 'playing' | 'ended'>('waiting');
  const [countdown, setCountdown] = useState(3);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  // Start from the passed practice set. Never fall back to the full
  // TRIVIA_QUESTIONS bank here — that mixed every topic together. Multiplayer
  // fills this in via the `triviaGameStart` socket event.
  const [questions, setQuestions] = useState<Question[]>(practiceQuestions && practiceQuestions.length > 0 ? practiceQuestions : []);
  const [currentTopic, setCurrentTopic] = useState<string>(topicName || "General");
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(15);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  const [winner, setWinner] = useState<string | null>(null);
  // One-line story under the results verdict (forfeit wins).
  const [endNote, setEndNote] = useState<string | null>(null);
  // Per-player "+XP / rank change" from the server, chained post-results.
  const { progression, clear: clearProgression } = useMatchProgression();
  // Practice (solo quiz) twin — self-reported XP, no rank. A solo round has
  // no opponent, so it reports result 'none' (participation + score XP).
  const { practiceProgression, armRound, reportRound, clearPracticeProgression } =
    usePracticeXp('trivia');
  /** Once-per-quiz guard: the report effect's deps churn while 'ended'. */
  const endReportedRef = useRef(false);
  const [opponentScore, setOpponentScore] = useState(0);
  const [players, setPlayers] = useState<any[]>([]);
  const [gameId, setGameId] = useState<string | null>(null);
  // Multiplayer only: the correct option index for the CURRENT question, as
  // revealed by the server (triviaAnswerResult / triviaReveal). The server
  // strips correctAnswer from triviaGameStart, so this is the only way a
  // multiplayer client ever learns the answer. null = not revealed yet.
  const [revealedAnswer, setRevealedAnswer] = useState<number | null>(null);

  // ── Matchmaking queue readout (FFA only) ──────────────────────────────────
  // The searching screen is OPTIMISTIC: it renders as soon as this component
  // mounts in multiplayer, never waiting for a server reply. These two values
  // only feed the `PLAYERS n / N` counter, refreshed by `queue:status`.
  const [queueCount, setQueueCount] = useState(1);
  const [queueNeeded, setQueueNeeded] = useState(2);
  // Set by `triviaMatched`: the roster is locked but the server is still
  // generating the question set (10-20s of LLM latency). Purely cosmetic —
  // it only swaps the searching screen's subtitle so the copy stops implying
  // we are still hunting for a human.
  const [matchedAwaitingQuestions, setMatchedAwaitingQuestions] = useState(false);

  const [sessionWinnings, setSessionWinnings] = useState<number>(0);

  // PRACTICE XP — one report per finished solo quiz, chained as the same
  // level-progression overlay online play gets. Multiplayer never reports
  // from here (its XP arrives on match:progression from the server).
  useEffect(() => {
    if (gameState === 'ended' && mode === 'practice') {
      if (endReportedRef.current) return;
      endReportedRef.current = true;
      reportRound({ result: 'none', score });
    } else if (gameState !== 'ended') {
      endReportedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState, mode, score]);
  const [correctCount, setCorrectCount] = useState<number>(0);
  const { win, wager, isFirstPractice } = useNeonBucks();

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const nextQuestionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  // Refs mirroring state the socket handlers need — the multiplayer effect
  // binds its listeners once, so reading state directly would be stale.
  const questionIndexRef = useRef(0);
  const gameStartedRef = useRef(false);
  useEffect(() => {
    questionIndexRef.current = currentQuestionIndex;
  }, [currentQuestionIndex]);
  // onExit is an inline prop — going through a ref keeps the multiplayer
  // effect from tearing down / re-queueing when the parent re-renders.
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  // Sync state if props change (e.g. new topic selected in lobby)
  useEffect(() => {
    if (practiceQuestions && practiceQuestions.length > 0) {
        setQuestions(practiceQuestions);
    }
    if (topicName) setCurrentTopic(topicName);
    setCurrentQuestionIndex(0);
    setScore(0);
    setCorrectCount(0);
    setSelectedOption(null);
    setIsCorrect(null);
    setRevealedAnswer(null);
    setTimeLeft(15);
    setGameState('waiting');
    
    if (mode === 'practice' && wagerAmount > 0) {
       // Refund the initial deduct from WagerMenu since Trivia is per-question
       if (!isFirstPractice) win(wagerAmount);
       setSessionWinnings(0);
    }
  }, [practiceQuestions, topicName, mode, wagerAmount]);

  // 3-2-1 intro countdown, then flip to 'playing'. Used by BOTH practice and
  // multiplayer (triviaGameStart) — without this the multiplayer client would
  // sit on the countdown screen forever, since only the server advances
  // questions and nothing else flips gameState.
  const runCountdown = useCallback(() => {
    setGameState('countdown');
    setCountdown(3);
    // Tracked in a ref, not a local, because the only thing that used to stop
    // this interval was `clearInterval` INSIDE the setCountdown updater — and
    // React skips updaters for an unmounted component. Exiting during the 3-2-1
    // therefore left a 1Hz interval ticking for the rest of the session.
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          if (countdownRef.current) clearInterval(countdownRef.current);
          countdownRef.current = null;
          setGameState('playing');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  // One teardown for every timer this component can leave behind. The question
  // timer already has its own (see below); these two did not.
  useEffect(
    () => () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (nextQuestionTimeoutRef.current) clearTimeout(nextQuestionTimeoutRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [],
  );

  // --- PRACTICE MODE LOGIC ---
  const startPracticeGame = useCallback(() => {
    runCountdown();
  }, [runCountdown]);

  const handleNextQuestion = useCallback(() => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(prev => prev + 1);
      setSelectedOption(null);
      setIsCorrect(null);
      setTimeLeft(15);
    } else {
      setGameState('ended');
      setWinner(profile?.name);
    }
  }, [currentQuestionIndex, questions.length, profile?.name]);

  const handleAnswer = useCallback((optionIndex: number | null, isTimeUp: boolean = false) => {
    if (selectedOption !== null || gameState !== 'playing' || !questions[currentQuestionIndex]) return;

    // ── Multiplayer: server-authoritative ───────────────────────────────────
    // The client never sees the answer key and never scores itself: it only
    // reports which option was picked (NO timeLeft — the server times us).
    // Correctness + reveal come back via `triviaAnswerResult`, scores only via
    // `triviaUpdate`, and the timeout reveal via `triviaReveal` — so when time
    // runs out there is nothing to send.
    if (mode === 'multiplayer') {
      if (isTimeUp || optionIndex === null) return;
      setSelectedOption(optionIndex); // lock the UI while awaiting the verdict
      if (socket && gameId) {
        socket.emit('triviaAnswer', { gameId, answerIndex: optionIndex });
      }
      return;
    }

    // ── Practice: local scoring (unchanged) ─────────────────────────────────
    let correct = false;
    if (!isTimeUp && optionIndex !== null) {
      setSelectedOption(optionIndex);
      correct = optionIndex === questions[currentQuestionIndex].correctAnswer;
    }
    setIsCorrect(correct);

    if (correct) {
      const points = Math.ceil(timeLeft * 10);
      setScore(prev => prev + points);
      setCorrectCount(prev => prev + 1);
    }

    // Per question wager update for practice
    if (wagerAmount > 0 && !isFirstPractice) {
       if (correct) {
          win(wagerAmount);
          setSessionWinnings(prev => prev + wagerAmount);
       } else {
          wager(wagerAmount);
          setSessionWinnings(prev => prev - wagerAmount);
       }
    } else if (wagerAmount > 0 && isFirstPractice) {
       if (correct) {
          win(wagerAmount);
          setSessionWinnings(prev => prev + wagerAmount);
       }
    }

    // In practice, auto-advance after 2 seconds
    nextQuestionTimeoutRef.current = setTimeout(() => {
      handleNextQuestion();
    }, 2000);
  }, [selectedOption, gameState, questions, currentQuestionIndex, timeLeft, mode, socket, gameId, handleNextQuestion, wagerAmount, isFirstPractice, win, wager, setCorrectCount]);

  // --- MULTIPLAYER LOGIC ---
  useEffect(() => {
    if (mode === 'multiplayer' && socket) {
      socket.emit('findTriviaGame', { profile, config });

      // Named handlers + handler-specific socket.off: the socket is the
      // SHARED game singleton, so blanket .off('event') would also strip
      // listeners owned by other components (and the global auth logger).
      const onTriviaGameStart = (data: any) => {
        gameStartedRef.current = true;
        setGameId(data.gameId);
        setQuestions(data.questions); // NOTE: server strips correctAnswer
        if (data.topic) setCurrentTopic(data.topic);
        setPlayers(data.players);
        // FFA late-join: server tells us which question is live.
        if (typeof data.currentQuestionIndex === 'number') {
          setCurrentQuestionIndex(data.currentQuestionIndex);
        }
        runCountdown();
      };

      // Live queue readout. The socket is the shared singleton, so filter by
      // game — chess/volley/connect publish the same event name.
      // Roster locked, questions still generating. The searching screen stays
      // up (only triviaGameStart clears it) but its subtitle now tells the
      // truth about what we are waiting on.
      const onTriviaMatched = () => setMatchedAwaitingQuestions(true);

      const onQueueStatus = (data: any) => {
        if (data?.game !== 'trivia' || !data?.inQueue) return;
        if (typeof data.current === 'number') setQueueCount(data.current);
        if (typeof data.needed === 'number' && data.needed > 0) {
          setQueueNeeded(data.needed);
        }
      };

      const onTriviaUpdate = (data: any) => {
        if (data.scores) {
          // Scores come ONLY from the server — no optimistic local adds.
          const myScore = data.scores[profile?.name ?? ''] || 0;
          setScore(myScore);
          // For 1v1, track opponent specifically
          if (config.mode === '1v1') {
            const oppName = Object.keys(data.scores).find(name => name !== profile?.name);
            if (oppName) setOpponentScore(data.scores[oppName]);
          }
          setPlayers(data.players);
        }
      };

      // Private verdict for OUR answer: correctness + the answer key.
      const onTriviaAnswerResult = (data: any) => {
        if (data.questionIndex !== questionIndexRef.current) return; // stale
        setIsCorrect(!!data.correct);
        setRevealedAnswer(data.correctAnswer);
        if (data.correct) setCorrectCount(prev => prev + 1);
      };

      // Room-wide reveal at the 15s deadline (covers players who never answered).
      const onTriviaReveal = (data: any) => {
        if (data.questionIndex !== questionIndexRef.current) return;
        setRevealedAnswer(prev => prev ?? data.correctAnswer);
      };

      const onTriviaNextQuestion = (data: any) => {
        setCurrentQuestionIndex(data.questionIndex);
        setSelectedOption(null);
        setIsCorrect(null);
        setRevealedAnswer(null);
        setTimeLeft(15);
      };

      const onTriviaEnded = (data: any) => {
        setGameState('ended');
        setWinner(data.winner);
        setPlayers(data.results);
        // Forfeit ending: the server already awarded the win — say so.
        if (data.reason === 'opponent_left') {
          setEndNote('Your opponent left the game — you win by forfeit');
        }
      };

      const onGameAuthError = (data: any) => {
        // Server refused matchmaking (e.g. account setup unfinished).
        console.warn('[trivia] cannot play online:', data?.message ?? data?.code);
        onExitRef.current();
      };

      const onConnectError = (err: Error) => {
        // Auth rejection while queueing would leave us on the scanning screen
        // forever — warn and bail back to the lobby.
        if (err.message === 'unauthorized' || err.message === 'auth_unavailable') {
          console.warn('[trivia] socket auth failed:', err.message);
          if (!gameStartedRef.current) onExitRef.current();
        }
      };

      socket.on('queue:status', onQueueStatus);
      socket.on('triviaMatched', onTriviaMatched);
      socket.on('triviaGameStart', onTriviaGameStart);
      socket.on('triviaUpdate', onTriviaUpdate);
      socket.on('triviaAnswerResult', onTriviaAnswerResult);
      socket.on('triviaReveal', onTriviaReveal);
      socket.on('triviaNextQuestion', onTriviaNextQuestion);
      socket.on('triviaEnded', onTriviaEnded);
      socket.on('gameAuthError', onGameAuthError);
      socket.on('connect_error', onConnectError);

      return () => {
        // Still queued (never matched)? Free the server-side queue slot.
        if (!gameStartedRef.current) socket.emit('leaveTriviaQueue');
        socket.off('queue:status', onQueueStatus);
        socket.off('triviaMatched', onTriviaMatched);
        socket.off('triviaGameStart', onTriviaGameStart);
        socket.off('triviaUpdate', onTriviaUpdate);
        socket.off('triviaAnswerResult', onTriviaAnswerResult);
        socket.off('triviaReveal', onTriviaReveal);
        socket.off('triviaNextQuestion', onTriviaNextQuestion);
        socket.off('triviaEnded', onTriviaEnded);
        socket.off('gameAuthError', onGameAuthError);
        socket.off('connect_error', onConnectError);
      };
    } else if (mode === 'practice') {
      startPracticeGame();
    }
  }, [mode, socket, profile, config, startPracticeGame, runCountdown]);

  // Timer logic
  useEffect(() => {
    if (gameState === 'playing' && timeLeft > 0) {
      timerRef.current = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            clearInterval(timerRef.current!);
            if (selectedOption === null) {
                // Time up
                handleAnswer(null, true);
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [gameState, timeLeft, selectedOption, handleAnswer]);

  return (
    <div className={`flex flex-col items-center justify-center h-screen w-screen bg-[#081616] font-body relative overflow-hidden`}>
      {/* HUD: Top Bar */}
      <AnimatePresence>
        {gameState === 'playing' && (
          <motion.div 
            initial={{ y: -100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="absolute top-0 left-0 right-0 z-20 p-8 flex justify-between items-start pointer-events-none"
          >
            {/* Left side stats */}
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-4 bg-black/40 backdrop-blur-md px-6 py-3 rounded-2xl border border-[#00FFD1]/20">
                <div className="w-10 h-10 rounded-full border border-[#00FFD1]/50 bg-[#00FFD1]/10 overflow-hidden">
                  <img src={profile?.avatarUrl ?? '/NeonArcadeLogo.png'} alt="Me" className="w-full h-full object-cover" />
                </div>
                <div>
                    <p className="text-white font-black text-sm uppercase italic tracking-wider leading-none mb-1">{profile?.name ?? 'Player'}</p>
                    <p className="text-[#00FFD1] text-xs font-mono font-bold leading-none">{score} PTS</p>
                </div>
              </div>
              
              {mode === 'multiplayer' && config.mode === '1v1' && (
                  <div className="flex items-center gap-4 bg-black/40 backdrop-blur-md px-6 py-3 rounded-2xl border border-white/5 opacity-60">
                    <div className="w-10 h-10 rounded-full border border-white/20 bg-white/5 flex items-center justify-center">
                        <Zap className="w-5 h-5 text-white/40" />
                    </div>
                    <div>
                        <p className="text-white font-black text-sm uppercase italic tracking-wider leading-none mb-1">Opponent</p>
                        <p className="text-[#B1C5FF] text-xs font-mono font-bold leading-none">{opponentScore} PTS</p>
                    </div>
                  </div>
              )}
            </div>

            {/* Centered Timer */}
            <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center">
                <div className={`w-20 h-20 rounded-full border-2 flex items-center justify-center backdrop-blur-xl transition-colors duration-500 ${timeLeft < 5 ? 'border-red-500 shadow-[0_0_20px_#ef4444]' : 'border-[#00FFD1] shadow-[0_0_20px_rgba(0,255,209,0.3)]'}`}>
                    <span className={`text-4xl font-black italic drop-shadow-md ${timeLeft < 5 ? 'text-red-500 animate-pulse' : 'text-white'}`}>{timeLeft}</span>
                </div>
                <div className="mt-4 flex gap-1">
                    {questions.map((_, i) => (
                        <div 
                          key={i} 
                          className={`w-2 h-2 rounded-full transition-all duration-300 ${i === currentQuestionIndex ? 'bg-[#00FFD1] w-6' : (i < currentQuestionIndex ? 'bg-[#00FFD1]/40' : 'bg-white/10')}`} 
                        />
                    ))}
                </div>
            </div>

            {/* Right side FFA Leaderboard */}
            {mode === 'multiplayer' && config.mode === 'ffa' && (
                <div className="bg-black/40 backdrop-blur-md p-4 rounded-2xl border border-[#00FFD1]/20 w-48">
                    <h4 className="text-[10px] font-mono tracking-widest text-[#00FFD1]/60 uppercase mb-3 text-center">Neural Strom</h4>
                    <div className="space-y-2">
                        {players.slice(0, 5).map((p, i) => (
                            <div key={p.name} className="flex justify-between items-center text-[10px]">
                                <span className={`font-bold transition-colors ${p.name === profile?.name ? 'text-[#00FFD1]' : 'text-white/60'}`}>{i + 1}. {p.name}</span>
                                <span className="font-mono text-white/40">{p.score}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Game Stage */}
      <div className="relative w-full max-w-4xl px-6 flex flex-col items-center z-10">
        <AnimatePresence mode="wait">
          {/* MATCHMAKING — shown the instant multiplayer is entered, with no
              dependency on a server ack (that dependency was the bug). Same
              shared component and same copy as every other online game; the
              old "Scanning Neural Grid" block lived here. */}
          {gameState === 'waiting' && mode === 'multiplayer' && (
            <motion.div
              key="waiting"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center w-full"
            >
              <SearchingForMatch
                playersInQueue={queueCount}
                // 1v1 hides the counter (no playersNeeded); FFA shows
                // PLAYERS n / N straight from the server's queue:status.
                playersNeeded={queueNeeded}
                // Once matched we are no longer searching — we are waiting on
                // the server's question set. Say so instead of lying.
                subtitle={
                  matchedAwaitingQuestions
                    ? 'Opponents locked in — preparing questions'
                    : undefined
                }
                onCancel={() => {
                  // Drop our queue entry — without this the 'cancelled'
                  // player could still get yanked into a match. The effect
                  // cleanup emits it again on unmount; it is idempotent.
                  socket?.emit('leaveTriviaQueue');
                  onExit();
                }}
              />
            </motion.div>
          )}

          {gameState === 'countdown' && (
            <motion.div
              key="countdown"
              initial={{ opacity: 0, scale: 2 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 5 }}
              className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none"
            >
              <span className="text-[200px] font-black text-[#00FFD1] italic drop-shadow-[0_0_50px_#00FFD1]">
                {countdown}
              </span>
            </motion.div>
          )}

          {gameState === 'playing' && questions.length > 0 && currentQuestionIndex < questions.length && (
            <motion.div 
              key={`q-${currentQuestionIndex}`}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="w-full space-y-12"
            >
              <div className="text-center space-y-4">
                  <span className="text-[10px] font-mono tracking-[0.5em] text-[#B1C5FF] uppercase font-bold px-4 py-1.5 rounded-full bg-[#B1C5FF]/10 border border-[#B1C5FF]/20">
                    Topic: {currentTopic}
                  </span>
                  <h1 className="text-3xl md:text-5xl font-black text-white italic tracking-tighter leading-tight drop-shadow-[0_0_20px_rgba(255,255,255,0.2)]">
                    {questions[currentQuestionIndex]?.question || 'Loading neural data...'}
                  </h1>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {questions[currentQuestionIndex]?.options?.map((option, idx) => {
                  const isSelected = selectedOption === idx;
                  // Where the answer key comes from depends on the mode:
                  // practice questions carry correctAnswer locally; multiplayer
                  // only learns it from the server's reveal events.
                  const answerKey = mode === 'multiplayer'
                    ? revealedAnswer
                    : (questions[currentQuestionIndex]?.correctAnswer ?? null);
                  const revealed = mode === 'multiplayer'
                    ? revealedAnswer !== null
                    : selectedOption !== null;
                  const isCorrectAnswer = answerKey === idx;
                  const locked = selectedOption !== null || revealed;

                  let borderColor = "border-white/10";
                  let bgColor = "bg-[rgba(255,255,255,0.05)]";
                  let textColor = "text-white/80";

                  if (revealed) {
                    if (isCorrectAnswer) {
                        borderColor = "border-[#00FFD1]";
                        bgColor = "bg-[#00FFD1]/20";
                        textColor = "text-[#00FFD1]";
                    } else if (isSelected) {
                        borderColor = "border-red-500";
                        bgColor = "bg-red-500/20";
                        textColor = "text-red-500";
                    }
                  } else if (isSelected) {
                    // Multiplayer: answer locked in, verdict still in flight.
                    borderColor = "border-[#00FFD1]/60";
                    bgColor = "bg-[#00FFD1]/10";
                    textColor = "text-white";
                  }

                  return (
                    <motion.button
                      key={idx}
                      whileHover={!locked ? { scale: 1.02, backgroundColor: "rgba(255, 255, 255, 0.08)" } : {}}
                      whileTap={!locked ? { scale: 0.98 } : {}}
                      onClick={() => handleAnswer(idx)}
                      disabled={locked}
                      className={`flex items-center gap-6 p-6 rounded-2xl border-2 backdrop-blur-md transition-all text-left group ${borderColor} ${bgColor} ${!locked ? 'cursor-pointer hover:border-white/20' : 'cursor-default'}`}
                    >
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-xl transition-colors ${revealed && isCorrectAnswer ? 'bg-[#00FFD1] text-[#081616]' : 'bg-white/10 text-white/40'}`}>
                        {String.fromCharCode(65 + idx)}
                      </div>
                      <span className={`text-xl font-bold uppercase tracking-wide ${textColor}`}>
                        {option}
                      </span>
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
          )}

          {gameState === 'ended' && (
            <ResultsScreen
              won={sessionWinnings > 0 || (isFirstPractice && sessionWinnings >= 0) || (mode === 'multiplayer' && winner === profile?.name)}
              stake={mode === 'practice' ? wagerAmount : 0}
              winnings={mode === 'practice' ? sessionWinnings : 0} // Profit for practice is exact sessionWinnings
              gameMode={mode === 'practice' ? 'Self-Wager' : 'Online'}
              // Online stakes nothing — hide the Wagered/Payout rows.
              moneyless={mode !== 'practice'}
              note={mode === 'multiplayer' ? endNote : null}
              questionsRight={correctCount /* multiplayer counts arrive via triviaAnswerResult */}
              onRematch={() => {
                   if (mode === 'practice') {
                       setGameState('waiting');
                       setCurrentQuestionIndex(0);
                       setScore(0);
                       setCorrectCount(0);
                       setSelectedOption(null);
                       setIsCorrect(null);
                       setTimeLeft(15);
                       // New quiz: re-arm the once-per-round guard and drop
                       // any overlay payload still queued from the last one.
                       armRound();
                       clearPracticeProgression();
                       clearProgression();
                       startPracticeGame();
                   } else {
                       window.location.reload(); // Simple way to rejoin
                   }
              }}
              onExit={onExit}
            />
          )}
        </AnimatePresence>

        {/* Level/rank progression, chained after the results screen. */}
        <PostGameProgression
          progression={progression ?? practiceProgression}
          onDone={() => {
            clearProgression();
            clearPracticeProgression();
          }}
        />
      </div>

      {/* Floating Controls */}
      <GameBackButton onClick={onExit} title="Exit Game" positionClassName="absolute bottom-8 left-8 z-[60]" />

      <div className="absolute bottom-8 right-8 flex gap-3 z-[60]">
        <button 
          onClick={toggleFullscreen}
          className="p-4 bg-[rgba(255,255,255,0.05)] border border-white/10 rounded-2xl text-[#00FFD1] hover:bg-[#00FFD1]/10 transition-all shadow-2xl active:scale-95"
          title="Toggle Fullscreen"
        >
          <Maximize2 className="w-6 h-6" />
        </button>
      </div>
      
      {/* Background Decor */}
      <div className="fixed inset-0 opacity-10 pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-gradient-to-r from-[#00FFD1] to-blue-600 rounded-full blur-[150px] animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-gradient-to-r from-purple-600 to-[#00FFD1] rounded-full blur-[150px] animate-pulse" style={{ animationDelay: '2s' }} />
      </div>
    </div>
  );
};

export default TriviaGame;
