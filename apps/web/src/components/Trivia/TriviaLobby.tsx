import React, { useState, useEffect, useRef } from "react";
import { ChevronLeft,
  Globe,
  Cpu,
  Maximize2,
  Users,
  Swords,
  CassetteTape,
  BookOpen,
  Timer,
  BarChart3,
  Zap,
  Eye,
  Rocket,
  Gamepad2,
  Code2,
  ShieldCheck,
  Terminal,
  Scroll,
  Atom,
  Tv,
  Mic2,
  Trophy,
  Flame, CircleDollarSign } from 'lucide-react';
import { motion, AnimatePresence } from "motion/react";
import { LibraryBlob } from "../glass/LibraryBlob";
import { ParticleCard, GlobalSpotlight } from "../glass/MagicGameTile";
import { generateQuestions as fetchQuizQuestions } from "./neonQuizApi";
import PrivateWagerRoom from "../social/PrivateWagerRoom";
import { usePrivateWagerStarted } from "../social/PrivateWagerInvite";
import LobbyModeTiles from "../common/LobbyModeTiles";

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3002';

interface TriviaLobbyProps {
  onFindGame: (config: { mode: "1v1" | "ffa" }) => void;
  onPlayPractice: (topicName: string, questions: any[]) => void;
  onExit: () => void;
}

const ICON_MAP: Record<string, any> = {
  cassette: CassetteTape,
  developer_board: Cpu,
  menu_book: BookOpen,
  timer: Timer,
  leaderboard: BarChart3,
  visibility: Eye,
  rocket_launch: Rocket,
  sports_esports: Gamepad2,
  code: Code2,
  safety_check: ShieldCheck,
  terminal: Terminal,
  philosophy: Scroll,
  science: Atom,
  pop_culture: Tv,
  rap: Mic2,
  basketball: Trophy,
  ufc: Flame,
};

const TopicIcon = ({
  name,
  className,
}: {
  name: string;
  className?: string;
}) => {
  const Icon = ICON_MAP[name] || Zap;
  return <Icon className={className || "w-6 h-6"} />;
};

const TriviaLobby = ({
  onFindGame,
  onPlayPractice,
  onExit,
}: TriviaLobbyProps) => {
  const [onlineMode, setOnlineMode] = useState<"1v1" | "ffa">("1v1");
  // PRIVATE WAGER: invite-only quiz against friends, in the configuration
  // selected above (Dual Link seats 2 and gets the diagonal duel layout;
  // Neural Storm seats up to 8 and shows only the players actually present).
  const [showPrivateWager, setShowPrivateWager] = useState(false);

  /**
   * A private match started from a room this lobby did NOT open — the invitee
   * accepted from the nav-bar bell, a pop-up, or a friend's row, and the app
   * navigated here so this component would be mounted and listening. Neon Quiz
   * only mounts its online screen on demand, so we hand off through the SAME
   * entry point the WAGER MATCH card uses — with the mode from the INVITE, not
   * from this lobby's picker.
   */
  usePrivateWagerStarted("trivia", (mode) => {
    if (mode === "1v1" || mode === "ffa") onFindGame({ mode });
  });
  const [view, setView] = useState<"main" | "library">("main");
  const [topics, setTopics] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const mainContainerRef = useRef<HTMLDivElement>(null);
  const libraryContainerRef = useRef<HTMLDivElement>(null);

  const fetchTopics = (refresh = false) => {
    setLoading(true);
    fetch(`${API_URL}/api/trivia/topics${refresh ? "?refresh=true" : ""}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        return res.json();
      })
      .then((data) => setTopics(data))
      .catch((err) => {
        console.error("Failed to load topics:", err);
        // Fallback static topics if API fails
        setTopics([
          {
            id: "philosophy",
            name: "Philosophy",
            description:
              "Existential logic and the nature of conscious reality",
            icon: "philosophy",
          },
          {
            id: "science",
            name: "Science",
            description: "Quantum mechanics and the fundamental laws of nature",
            icon: "science",
          },
          {
            id: "tech",
            name: "Tech",
            description: "AI, Cybernetics, and the evolution of the machine",
            icon: "developer_board",
          },
          {
            id: "pop-culture",
            name: "Pop Culture",
            description: "Digital echoes of music, movies, and old-world media",
            icon: "pop_culture",
          },
          {
            id: "rap",
            name: "Rap",
            description: "Lyrical systems and the history of hip-hop flow",
            icon: "rap",
          },
          {
            id: "basketball",
            name: "Basketball",
            description: "Legends of the court and the stats behind the game",
            icon: "basketball",
          },
          {
            id: "ufc",
            name: "UFC",
            description: "Adrenaline and precision in the octane arena",
            icon: "ufc",
          },
        ]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (view === "library") {
      fetchTopics();
    }
  }, [view]);

  const handleRefreshThemes = () => {
    setLoading(true);
    fetchTopics(true);
    setTimeout(() => setLoading(false), 2000); // UI breathing room
  };

  const handleSelectTopic = async (topic: any) => {
    setLoading(true);
    try {
      // withAnswers: true — solo practice scores locally, so we need the
      // correct index. The AI generates questions ON this exact topic.
      const data = await fetchQuizQuestions(topic.name, 10, 'mixed', true);
      if (!data.questions?.length) throw new Error('No questions returned');
      onPlayPractice(topic.name, data.questions);
    } catch (err) {
      console.error("Trivia generation error:", err);
      // Offline fallback: only ever use questions that actually match this
      // topic. Never scramble in questions from other categories — that was
      // the "jumbled topics" bug.
      const { TRIVIA_QUESTIONS } = await import("./TriviaQuestions");
      const normalizedTopic = topic.name.trim().toLowerCase();
      const onTopic = TRIVIA_QUESTIONS.filter(
        (q) => q.category.trim().toLowerCase() === normalizedTopic,
      );
      if (onTopic.length > 0) {
        onPlayPractice(topic.name, onTopic);
      } else {
        // No on-topic offline questions — tell the user instead of showing
        // unrelated ones.
        alert(
          `Couldn't generate questions for "${topic.name}". Check that the server is running and OPENROUTER_API_KEY is set, then try again.`,
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "f") {
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="min-h-screen bg-[#081616] flex flex-col items-center justify-center p-6 relative overflow-hidden">
      <LibraryBlob />
      
      {/* Animated background highlights */}
      <div className="absolute inset-0 opacity-20 pointer-events-none">
        <div className="absolute top-20 left-20 w-96 h-96 bg-[#00FFD1] rounded-full blur-[120px] opacity-20 animate-pulse"></div>
        <div
          className="absolute bottom-20 right-20 w-96 h-96 bg-[#0452c4] rounded-full blur-[120px] opacity-20 animate-pulse"
          style={{ animationDelay: "1s" }}
        ></div>
      </div>

      <div className="relative z-10 text-center space-y-8 w-full">
        <AnimatePresence mode="wait">
          {view === "main" ? (
            <motion.div
              key="main"
              ref={mainContainerRef}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8 max-w-2xl mx-auto"
            >
              <GlobalSpotlight gridRef={mainContainerRef} />
              <div className="space-y-2">
                <h1 className="text-6xl md:text-8xl font-black text-[#FFFFFD] drop-shadow-[0_0_20px_rgba(0,255,209,0.6)] uppercase tracking-tighter italic">
                  NEON QUIZ
                </h1>
              </div>

              <div className="space-y-6">
                <div className="flex flex-col items-center gap-3">
                  <p className="text-[10px] font-mono tracking-[0.3em] uppercase text-[#B1C5FF]/50">
                    Match Configuration
                  </p>
                  <div className="flex gap-2 p-1 bg-[#111E1E]/80 border border-[#00FFD1]/20 rounded-lg backdrop-blur-md">
                    <button
                      onClick={() => setOnlineMode("1v1")}
                      className={`px-6 py-2 rounded-md text-[10px] font-bold uppercase tracking-widest transition-all ${
                        onlineMode === "1v1"
                          ? "bg-[#00FFD1] text-[#081616] shadow-[0_0_15px_rgba(0,255,209,0.5)]"
                          : "text-[#B1C5FF]/50 hover:text-[#B1C5FF]"
                      }`}
                    >
                      Dual Link (1v1)
                    </button>
                    <button
                      onClick={() => setOnlineMode("ffa")}
                      className={`px-6 py-2 rounded-md text-[10px] font-bold uppercase tracking-widest transition-all ${
                        onlineMode === "ffa"
                          ? "bg-[#00FFD1] text-[#081616] shadow-[0_0_15px_rgba(0,255,209,0.5)]"
                          : "text-[#B1C5FF]/50 hover:text-[#B1C5FF]"
                      }`}
                    >
                      Neural Storm (FFA)
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full text-left">
                <ParticleCard
                  onClick={() => onFindGame({ mode: onlineMode })}
                  className="magic-bento-card magic-bento-card--border-glow px-8 py-6 bg-gradient-to-br from-[#00FFD1] to-[#00bda0] text-[#081616] rounded-2xl hover:shadow-[0_0_50px_rgba(0,255,209,0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer"
                >
                  <div className="absolute top-0 left-0 w-full h-1 bg-white/20"></div>
                  {onlineMode === "1v1" ? (
                    <Swords className="w-8 h-8 group-hover:rotate-12 transition-transform" />
                  ) : (
                    <Users className="w-8 h-8 group-hover:rotate-12 transition-transform" />
                  )}
                  {/* NO MONEY ONLINE: this card used to read "Wager Match".
                      Online quizzes stake nothing — real opponents, free entry
                      — so the copy says that. Clicking goes straight to
                      matchmaking; there is no wager step on this path. */}
                  <div className="text-center">
                    <span className="block font-black text-xl uppercase tracking-tighter italic leading-none">Wager Match</span>
                    <span className="block text-[8px] opacity-60 font-bold tracking-widest mt-1">
                      GLOBAL WAGER ARENA
                    </span>
                  </div>
                </ParticleCard>

                {/* PRIVATE WAGER — new card (this lobby has no local co-op to
                    replace), styled exactly like Practice per the contract. */}
                <ParticleCard
                  onClick={() => setShowPrivateWager(true)}
                  className="magic-bento-card magic-bento-card--border-glow px-8 py-6 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer hover:border-[#00FFD1]"
                >
                  <Swords className="w-8 h-8 text-zinc-400 group-hover:rotate-12 transition-transform group-hover:text-[#00FFD1]" />
                  <div className="text-center">
                    <span className="block font-black text-xl uppercase tracking-tighter italic leading-none">
                      Private Wager
                    </span>
                    <span className="block text-[8px] text-white/40 font-bold tracking-widest mt-1">
                      INVITE A FRIEND
                    </span>
                  </div>
                </ParticleCard>

                <ParticleCard
                  onClick={() => setView("library")}
                  className="magic-bento-card magic-bento-card--border-glow px-8 py-6 border border-[#00FFD1]/40 text-white rounded-2xl transition-all duration-500 hover:scale-[1.02] active:scale-[0.98] flex flex-col items-center justify-center gap-4 group relative overflow-hidden cursor-pointer hover:border-[#00FFD1]"
                >
                  <Cpu className="w-8 h-8 text-zinc-400 group-hover:rotate-12 transition-transform group-hover:text-[#00FFD1]" />
                  <div className="text-center">
                    <span className="block font-black text-xl uppercase tracking-tighter italic leading-none">
                      Practice
                    </span>
                    <span className="block text-[8px] text-white/40 font-bold tracking-widest mt-1">
                      SELF-WAGER TRAINING
                    </span>
                  </div>
                </ParticleCard>
              </div>
          {/* Shared lobby footer — see common/LobbyModeTiles. */}
          <LobbyModeTiles />
            </motion.div>
          ) : (
            <motion.div
              key="library"
              ref={libraryContainerRef}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="space-y-8 w-full max-w-4xl mx-auto"
            >
              <GlobalSpotlight gridRef={libraryContainerRef} />
              <div className="flex justify-between items-end mb-8">
                <div className="text-left">
                  <h2 className="text-4xl font-black text-white italic uppercase tracking-tighter">
                    Topic Library
                  </h2>
                  <p className="text-[#00FFD1] font-mono text-xs tracking-widest uppercase">
                    Select domain for neural training
                  </p>
                </div>
                <button
                  onClick={handleRefreshThemes}
                  className="flex items-center gap-2 px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-[10px] font-mono text-[#00FFD1] hover:bg-[#00FFD1]/10 transition-all uppercase tracking-widest"
                >
                  <Globe className="w-3 h-3" />
                  Refresh Uplink
                </button>
              </div>

              {loading ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <div className="w-12 h-12 border-4 border-[#00FFD1]/20 border-t-[#00FFD1] rounded-full animate-spin mb-4" />
                  <p className="text-white font-mono text-xs uppercase tracking-widest animate-pulse">
                    Generating neural data...
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {topics.map((topic) => (
                    <ParticleCard
                      key={topic.id}
                      onClick={() => handleSelectTopic(topic)}
                      className="magic-bento-card magic-bento-card--border-glow group p-6 bg-[#111E1E]/60 border border-white/5 rounded-2xl text-left transition-all text-white cursor-pointer"
                    >
                      <div className="flex items-center gap-4 mb-3">
                        <div className="p-3 bg-white/5 rounded-xl text-[#00FFD1] group-hover:bg-[#00FFD1] group-hover:text-[#081616] transition-colors">
                          <TopicIcon name={topic.icon} className="w-6 h-6" />
                        </div>
                        <h3 className="font-black text-lg uppercase tracking-tighter italic">
                          {topic.name}
                        </h3>
                      </div>
                      <p className="text-xs text-white/40 font-medium leading-relaxed group-hover:text-white/60">
                        {topic.description}
                      </p>
                    </ParticleCard>
                  ))}

                  {/* Custom Topic Selection */}
                  <div className="p-6 bg-black/40 border border-dashed border-white/10 rounded-2xl flex flex-col justify-center gap-3">
                    <p className="text-[10px] font-mono tracking-widest uppercase text-white/40">
                      Manual Uplink
                    </p>
                    <input
                      type="text"
                      placeholder="ENTER TOPIC..."
                      className="bg-transparent border-b border-white/20 text-white font-black uppercase tracking-tighter italic focus:outline-none focus:border-[#00FFD1] placeholder:text-white/10"
                      onKeyDown={(e: any) => {
                        if (e.key === "Enter" && e.target.value.trim()) {
                          handleSelectTopic({ name: e.target.value.trim() });
                        }
                      }}
                    />
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Floating Controls */}
      <div className="fixed bottom-8 right-8 flex gap-3 z-[60]">
        <button
          onClick={toggleFullscreen}
          className="p-4 bg-white/5 border border-white/10 rounded-2xl text-[#00FFD1] hover:bg-[#00FFD1]/10 transition-all shadow-2xl active:scale-95"
          title="Toggle Fullscreen"
        >
          <Maximize2 className="w-6 h-6" />
        </button>
      </div>

      {/* Private-wager waiting room.
          Unlike Chess/Volley/Golf, TriviaCore only mounts TriviaGame (and with
          it the `triviaGameStart` listener) once the player is in online mode
          — so when the server starts the private match we hand off through the
          SAME entry point the WAGER MATCH card uses. TriviaGame then re-sends
          `findTriviaGame`, which the server treats as a rebind/re-queue for a
          wallet it already seated. */}
      {showPrivateWager && (
        <PrivateWagerRoom
          gameKey="trivia"
          mode={onlineMode}
          onClose={() => setShowPrivateWager(false)}
          onStarted={() => onFindGame({ mode: onlineMode })}
        />
      )}
    </div>
  );
};

export default TriviaLobby;
