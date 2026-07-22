import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Trophy, Timer, ChevronLeft, Maximize2, Zap, Brain, Target, Info } from 'lucide-react';
import { TRIVIA_QUESTIONS, Question } from './TriviaQuestions';
import { Socket } from 'socket.io-client';
import { ResultsScreen } from '../NeonBucks/ResultsScreen';
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
  const [questions, setQuestions] = useState<Question[]>(practiceQuestions && practiceQuestions.length > 0 ? practiceQuestions : TRIVIA_QUESTIONS);
  const [currentTopic, setCurrentTopic] = useState<string>(topicName || "General");
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(15);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  const [winner, setWinner] = useState<string | null>(null);
  const [opponentScore, setOpponentScore] = useState(0);
  const [players, setPlayers] = useState<any[]>([]);
  const [gameId, setGameId] = useState<string | null>(null);

  const [sessionWinnings, setSessionWinnings] = useState<number>(0);
  const [correctCount, setCorrectCount] = useState<number>(0);
  const { win, wager, isFirstPractice } = useNeonBucks();

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const nextQuestionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
    setTimeLeft(15);
    setGameState('waiting');
    
    if (mode === 'practice' && wagerAmount > 0) {
       // Refund the initial deduct from WagerMenu since Trivia is per-question
       if (!isFirstPractice) win(wagerAmount);
       setSessionWinnings(0);
    }
  }, [practiceQuestions, topicName, mode, wagerAmount]);

  // --- PRACTICE MODE LOGIC ---
  const startPracticeGame = useCallback(() => {
    setGameState('countdown');
    setCountdown(3);
    const interval = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          setGameState('playing');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

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
    if (mode === 'practice' && wagerAmount > 0 && !isFirstPractice) {
       if (correct) {
          win(wagerAmount);
          setSessionWinnings(prev => prev + wagerAmount);
       } else {
          wager(wagerAmount);
          setSessionWinnings(prev => prev - wagerAmount);
       }
    } else if (mode === 'practice' && wagerAmount > 0 && isFirstPractice) {
       if (correct) {
          win(wagerAmount);
          setSessionWinnings(prev => prev + wagerAmount);
       }
    }

    if (mode === 'multiplayer' && socket && gameId) {
      socket.emit('triviaAnswer', { gameId, answerIndex: optionIndex ?? -1, timeLeft: isTimeUp ? 0 : timeLeft });
    } else {
      // In practice, auto-advance after 2 seconds
      nextQuestionTimeoutRef.current = setTimeout(() => {
        handleNextQuestion();
      }, 2000);
    }
  }, [selectedOption, gameState, questions, currentQuestionIndex, timeLeft, mode, socket, gameId, handleNextQuestion, wagerAmount, isFirstPractice, win, wager, setCorrectCount]);

  // --- MULTIPLAYER LOGIC ---
  useEffect(() => {
    if (mode === 'multiplayer' && socket) {
      socket.emit('findTriviaGame', { profile, config });

      socket.on('triviaGameStart', (data: any) => {
        setGameId(data.gameId);
        setQuestions(data.questions);
        if (data.topic) setCurrentTopic(data.topic);
        setPlayers(data.players);
        setGameState('countdown');
        setCountdown(3);
      });

      socket.on('triviaUpdate', (data: any) => {
          if (data.scores) {
              const myScore = data.scores[profile.name] || 0;
              setScore(myScore);
              // For 1v1, track opponent specifically
              if (config.mode === '1v1') {
                  const oppName = Object.keys(data.scores).find(name => name !== profile.name);
                  if (oppName) setOpponentScore(data.scores[oppName]);
              }
              setPlayers(data.players);
          }
      });

      socket.on('triviaNextQuestion', (data: any) => {
        setCurrentQuestionIndex(data.questionIndex);
        setSelectedOption(null);
        setIsCorrect(null);
        setTimeLeft(15);
      });

      socket.on('triviaEnded', (data: any) => {
        setGameState('ended');
        setWinner(data.winner);
        setPlayers(data.results);
      });

      return () => {
        socket.off('triviaGameStart');
        socket.off('triviaUpdate');
        socket.off('triviaNextQuestion');
        socket.off('triviaEnded');
      };
    } else if (mode === 'practice') {
      startPracticeGame();
    }
  }, [mode, socket, profile, config, startPracticeGame]);

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
                  <img src={profile.avatarUrl} alt="Me" className="w-full h-full object-cover" />
                </div>
                <div>
                    <p className="text-white font-black text-sm uppercase italic tracking-wider leading-none mb-1">{profile.name}</p>
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
                                <span className={`font-bold transition-colors ${p.name === profile.name ? 'text-[#00FFD1]' : 'text-white/60'}`}>{i + 1}. {p.name}</span>
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
          {gameState === 'waiting' && mode === 'multiplayer' && (
            <motion.div 
              key="waiting"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center"
            >
              <div className="relative">
                <div className="w-32 h-32 rounded-full border-4 border-[#00FFD1]/20 border-t-[#00FFD1] animate-spin mb-8" />
                <Brain className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 text-[#00FFD1] animate-pulse" />
              </div>
              <h2 className="text-4xl font-black text-white italic tracking-tighter uppercase mb-4">Scanning Neural Grid</h2>
              <p className="text-[#00FFD1] font-mono tracking-widest text-xs uppercase animate-pulse">Waiting for synchronization...</p>
              
              <button 
                onClick={onExit}
                className="mt-12 px-8 py-3 rounded-xl border border-white/10 text-white/40 font-bold uppercase tracking-widest text-[10px] hover:bg-white/5 transition-all"
              >
                Abort Link
              </button>
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
                  const isCorrectAnswer = questions[currentQuestionIndex]?.correctAnswer === idx;
                  
                  let borderColor = "border-white/10";
                  let bgColor = "bg-[rgba(255,255,255,0.05)]";
                  let textColor = "text-white/80";

                  if (selectedOption !== null) {
                    if (isCorrectAnswer) {
                        borderColor = "border-[#00FFD1]";
                        bgColor = "bg-[#00FFD1]/20";
                        textColor = "text-[#00FFD1]";
                    } else if (isSelected) {
                        borderColor = "border-red-500";
                        bgColor = "bg-red-500/20";
                        textColor = "text-red-500";
                    }
                  }

                  return (
                    <motion.button
                      key={idx}
                      whileHover={selectedOption === null ? { scale: 1.02, backgroundColor: "rgba(255, 255, 255, 0.08)" } : {}}
                      whileTap={selectedOption === null ? { scale: 0.98 } : {}}
                      onClick={() => handleAnswer(idx)}
                      disabled={selectedOption !== null}
                      className={`flex items-center gap-6 p-6 rounded-2xl border-2 backdrop-blur-md transition-all text-left group ${borderColor} ${bgColor} ${selectedOption === null ? 'cursor-pointer hover:border-white/20' : 'cursor-default'}`}
                    >
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-xl transition-colors ${selectedOption !== null && isCorrectAnswer ? 'bg-[#00FFD1] text-[#081616]' : 'bg-white/10 text-white/40'}`}>
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
              questionsRight={mode === 'practice' ? correctCount : Math.round((score / 150) * questions.length)/* rough estimate since score=timeLeft*10 */}
              onRematch={() => {
                   if (mode === 'practice') {
                       setGameState('waiting');
                       setCurrentQuestionIndex(0);
                       setScore(0);
                       setCorrectCount(0);
                       setSelectedOption(null);
                       setIsCorrect(null);
                       setTimeLeft(15);
                       startPracticeGame();
                   } else {
                       window.location.reload(); // Simple way to rejoin
                   }
              }}
              onExit={onExit}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Floating Controls */}
      <div className="absolute bottom-8 left-8 flex gap-3 z-[60]">
        <button
          onClick={onExit}
          className="p-2.5 border border-red-500/40 rounded-full bg-[#081616]/80 text-red-500 hover:bg-red-500/20 hover:shadow-[0_0_15px_rgba(239,68,68,0.3)] transition-all flex items-center justify-center cursor-pointer select-none"
          title="Exit Game"
        >
          <ChevronLeft size={24} />
        </button>
      </div>

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
