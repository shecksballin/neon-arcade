import React from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Ghost,
  Skull,
  FlagTriangleRight,
  Compass,
  Activity,
  BarChart3,
  Gamepad2,
  Trophy,
  Plus,
  Flame,
  User,
  Wallet,
  Swords,
  CircleDot,
  Crosshair,
  Orbit,
  Rocket,
  Brain,
  ChevronLeft,
  Menu as MenuIcon,
  Settings,
  Bell,
  Gift,
  Check,
  Sparkles,
  Clock,
} from "lucide-react";
import { Howler } from "howler";

import { useNeonBucks } from "./NeonBucksStore";
import { AccountSetup } from "./components/AccountSetup";
import { ProfileSettings } from "./components/ProfileSettings";
import NeonConnectGame from "./components/NeonConnect/NeonConnectGame";
import ChessGame from "./components/Chess/ChessGame";
import VolleyGame from "./components/Volley/VolleyGame";
import CellsGame from "./components/Cells/CellsGame";
import AsteroidsGame from "./components/Asteroids/AsteroidsGame";
import TriviaGame from "./components/Trivia/TriviaCore";
import GolfGame from "./components/Golf/GolfGame";
import ClumsyGame from "./components/Clumsy/ClumsyGame";
import KillerGame from "./components/Killer/KillerGame";
import PugShooterGame from "./components/PugShooter/PugShooterGame";
import { io } from "socket.io-client";

import { SidebarMenu } from "./components/SidebarMenu";

import { LiquidFilter } from "./components/glass/LiquidFilter";
import { CursorBlob3D } from "./components/glass/CursorBlob3D";
import { CursorGlow } from "./components/glass/CursorGlow";
import { GlassPanel } from "./components/glass/GlassPanel";
import { LibraryBlob } from "./components/glass/LibraryBlob";
import { MagicBentoGameTile, GlobalSpotlight } from "./components/glass/MagicGameTile";
import { SplashCursor } from "./components/SplashCursor";
import { NeonViewportGlow } from "./components/NeonViewportGlow";
import { SafeErrorBoundary } from "./components/SafeErrorBoundary";
import ActiveUsers from "./components/ActiveUsers";
import { useActiveUsers } from "./hooks/useActiveUsers";
import TrueFocus from "./components/TrueFocus";

import { usePrivy, useLogin } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import { useBackendAuth, AUTH_TOKEN_KEY } from "./hooks/useBackendAuth";
import { WalletPanel } from "./components/WalletPanel";
import { profileApi, ApiError } from "./lib/api";
import { AVATAR_LIST } from "./lib/avatars";

type View =
  | "landing"
  | "arcade"
  | "neonconnect"
  | "chess"
  | "volley"
  | "cells"
  | "asteroids"
  | "trivia"
  | "golf"
  | "clumsy"
  | "killer"
  | "pugshooter"
  | "account_setup";

interface Profile {
  name: string;
  avatarUrl: string;
}

// What the backend says about the signed-in wallet's account. `null`
// until fetched (or when signed out).
interface BackendAccount {
  username: string | null;
  totpEnabled: boolean;
}

// v2: profiles are backed by the server's unique-username registry.
// The legacy key held self-chosen local names — nullified on boot (the
// username registry restarted from zero when accounts landed).
const PROFILE_STORAGE_KEY = "neon_arcade_profile_v2";
const LEGACY_PROFILE_KEY = "neon_arcade_profile";

export default function App() {
  const { activeUsers, connected } = useActiveUsers();

  // Privy session + the bridge that turns it into our backend JWT
  const { ready: privyReady, authenticated, logout } = usePrivy();
  const { wallets } = useWallets();

  // The Create Account panel opens the moment Privy sign-on completes —
  // not after the wallet appears and the backend signature exchange
  // lands. AccountSetup itself shows the wallet/signature progress and
  // self-dismisses for accounts that are already complete, so following
  // up unconditionally is safe.
  const { login } = useLogin({
    onComplete: () => {
      setGameInSession(false);
      setView("account_setup");
    },
  });
  const { clearSession } = useBackendAuth();
  // "Already auto-followed-up once this session" — restored sessions get
  // one automatic push into Create Account; after that the gates
  // (Connect / Play Now / tiles) take over.
  const autoFollowUpDone = React.useRef(false);

  const { win, balance } = useNeonBucks();
  const [view, setView] = React.useState<View>("landing");
  const [profile, setProfile] = React.useState<Profile | null>(null);
  // Backend account status — drives the sign-in gate on Connect /
  // Play Now / game tiles. Where the user was headed when the gate
  // interrupted them lives in pendingDest until setup finishes.
  const [account, setAccount] = React.useState<BackendAccount | null>(null);
  const pendingDest = React.useRef<View | null>(null);
  const [showSettings, setShowSettings] = React.useState(false);
  const [showWallet, setShowWallet] = React.useState(false);
  const [gameInSession, setGameInSession] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [masterVolume, setMasterVolume] = React.useState<number>(() => {
    const saved = localStorage.getItem("masterVolume");
    return saved !== null ? parseFloat(saved) : 0.5;
  });
  const [showVolumeConfig, setShowVolumeConfig] = React.useState(false);
  
  const [showNotifications, setShowNotifications] = React.useState(false);
  const notificationRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (notificationRef.current && !notificationRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [notificationRef]);
  const [lastClaimedDate, setLastClaimedDate] = React.useState<string | null>(() => {
    return localStorage.getItem("last_claimed_daily");
  });

  const dailyAvailable = lastClaimedDate !== new Date().toDateString();

  const handleClaimDaily = () => {
    if (dailyAvailable) {
      const todayString = new Date().toDateString();
      localStorage.setItem("last_claimed_daily", todayString);
      setLastClaimedDate(todayString);
      win(20);
    }
  };

  React.useEffect(() => {
    // Nullify pre-account usernames: the registry restarted from zero,
    // so locally stored legacy profiles no longer name anyone.
    localStorage.removeItem(LEGACY_PROFILE_KEY);

    const saved = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setProfile(parsed);
      } catch (e) {
        console.error("Failed to parse profile", e);
      }
    }

    // Set up custom event listener to toggle modern navigation menu from game HUDs
    const handleOpenMenu = () => setMenuOpen(true);
    window.addEventListener("open-neon-arcade-menu", handleOpenMenu);

    // Initial global sound configuration
    const savedVol = localStorage.getItem("masterVolume");
    const vol = savedVol !== null ? parseFloat(savedVol) : 0.5;
    Howler.volume(vol);

    const isMuted = localStorage.getItem("gameMuted") === "true";
    Howler.mute(isMuted);

    return () => {
      window.removeEventListener("open-neon-arcade-menu", handleOpenMenu);
    };
  }, []);

  // Close navigation menu whenever the active view changes or a game session finishes/changes
  React.useEffect(() => {
    setMenuOpen(false);
  }, [view, gameInSession]);

  // Fetch the backend account for the signed-in wallet and route into
  // AccountSetup when it's missing/unfinished. Returns the fresh status
  // so callers can branch without waiting for state.
  const refreshAccount = React.useCallback(async (): Promise<BackendAccount | null> => {
    try {
      const me = await profileApi.me();
      const next = { username: me.username, totpEnabled: me.totpEnabled };
      setAccount(next);
      return next;
    } catch (err) {
      console.error("Account lookup failed:", err);
      // A stale token (expired, or the signing secret rotated) can't be
      // used again — drop it so the Create Account panel's connect phase
      // re-runs the signature exchange instead of looping on 401s.
      if (err instanceof ApiError && err.status === 401) {
        localStorage.removeItem(AUTH_TOKEN_KEY);
      }
      return null;
    }
  }, []);

  // Follow-up rule: ANY signed-in session without a finished account
  // lands in Create Account — fresh logins via useLogin's onComplete
  // above, and restored/redirect sessions here. The panel drives the
  // wallet wait + signature exchange itself and self-dismisses when the
  // account turns out to be complete, so this never strands anyone.
  React.useEffect(() => {
    if (!authenticated) {
      autoFollowUpDone.current = false;
      setAccount(null);
      return;
    }
    if (!privyReady || autoFollowUpDone.current) return;

    const followUp = () => {
      autoFollowUpDone.current = true;
      setGameInSession(false);
      setView("account_setup");
    };

    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (token) {
      // Session JWT already stored — one quick status check (no
      // signature involved) decides whether to push into setup, so
      // finished accounts reload without any panel flash.
      if (account) return;
      autoFollowUpDone.current = true;
      refreshAccount().then((acct) => {
        const complete = !!(acct?.username && acct.totpEnabled);
        const tokenDropped = !localStorage.getItem(AUTH_TOKEN_KEY);
        // Incomplete account, or the token turned out stale (a fresh
        // signature is needed anyway) → Create Account owns the rest.
        if (!complete && (acct || tokenDropped)) followUp();
      });
      return;
    }

    // Signed in but no session JWT yet (first visit after login, or a
    // cleared token): don't pop a bare signature dialog over the landing
    // page — open Create Account and let its connect phase ask for the
    // signature with context. Waits for the embedded wallet, which can
    // lag `authenticated` by a beat.
    if (wallets.length === 0) return;
    followUp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privyReady, authenticated, wallets, account, refreshAccount]);

  // Fresh device with a finished account: rebuild the local display
  // profile from the backend username (avatar defaults; editable in
  // settings, where the name itself is locked to the registry).
  React.useEffect(() => {
    if (!profile && account?.username && account.totpEnabled) {
      const rebuilt = { name: account.username, avatarUrl: AVATAR_LIST[0] };
      setProfile(rebuilt);
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(rebuilt));
    }
  }, [account, profile]);

  // Whether this wallet finished the whole flow: signed in, unique
  // username claimed, PIN set, authenticator proven.
  const hasAccount = !!(account?.username && account.totpEnabled);

  // THE GATE. Connect, Play Now and every game tile route through here:
  //   signed out            → Privy wallet popup (setup follows sign-in)
  //   signed in, no account → username + PIN + authenticator screen
  //   account complete      → straight to the destination
  const requireAccount = React.useCallback(
    (dest: View) => {
      setGameInSession(false);
      if (!privyReady) return;
      if (!authenticated) {
        pendingDest.current = dest;
        login();
        return;
      }
      if (!hasAccount) {
        pendingDest.current = dest;
        setView("account_setup");
        return;
      }
      setView(dest);
    },
    [privyReady, authenticated, hasAccount, login]
  );

  const handleVolumeChange = (vol: number) => {
    setMasterVolume(vol);
    localStorage.setItem("masterVolume", vol.toString());
    Howler.volume(vol);
  };

  // Play Now is a gated entry point: wallet popup first for signed-out
  // users, then username/PIN/authenticator, then the arcade.
  const handlePlayNow = () => {
    requireAccount("arcade");
  };

  const navigateToLanding = () => {
    setGameInSession(false);
    setView("landing");
  };

  // AccountSetup finished: username registered, PIN saved, authenticator
  // proven. Persist the display profile and continue to wherever the
  // gate interrupted (arcade by default). Returning users keep their
  // locally chosen avatar — only the name is registry-owned.
  const handleAccountComplete = (incoming: Profile) => {
    const newProfile = {
      name: incoming.name,
      avatarUrl: profile?.avatarUrl ?? incoming.avatarUrl,
    };
    setAccount({ username: newProfile.name, totpEnabled: true });
    setProfile(newProfile);
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(newProfile));
    const dest = pendingDest.current ?? "arcade";
    pendingDest.current = null;
    setGameInSession(false);
    setView(dest === "account_setup" ? "arcade" : dest);
  };

  const handleDisconnectWallet = async () => {
    setShowWallet(false);
    clearSession(); // our backend JWT dies with the Privy session
    await logout();
  };

  const handleProfileUpdate = (newProfile: Profile) => {
    // The display name is locked to the registered unique username —
    // only the avatar is editable client-side.
    const next = { ...newProfile, name: account?.username ?? newProfile.name };
    setProfile(next);
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(next));
  };

  const viewToGameTitle: Record<string, string> = {
    neonconnect: "Neon Connect",
    chess: "Neon Chess",
    trivia: "Neon Quiz",
    cells: "Neon Cells",
    asteroids: "Neon Asteroids",
    volley: "Neon Volley",
    golf: "Neon Golf Clash",
    clumsy: "Neon Clumsy",
    killer: "Neon Killer",
    pugshooter: "Neon Pug Shooter",
  };

  return (
    <div className="font-sans selection:bg-cyan-500/30 selection:text-cyan-200 h-screen overflow-hidden bg-[#081616] text-[#d7e5e5]">
      <LiquidFilter />
      <NeonViewportGlow />
      {(view === "landing" ||
        view === "arcade" ||
        view === "neonconnect" ||
        view === "chess" ||
        view === "trivia" ||
        view === "cells" ||
        view === "asteroids" ||
        view === "golf" ||
        view === "clumsy" ||
        view === "killer" ||
        view === "pugshooter" ||
        view === "volley") && (
        <SidebarMenu 
          gameTitle={viewToGameTitle[view] || "Neon Arcade"} 
          isOpen={menuOpen}
          onClose={() => setMenuOpen(false)}
          showDefaultTrigger={false}
        />
      )}

      {/* Standalone Menu Button aligned vertically with the nav bar at top-6 */}
      {view !== "cells" && view !== "asteroids" && view !== "account_setup" && !gameInSession && (
        <button
          onClick={() => setMenuOpen(true)}
          className="fixed top-6 left-6 z-[60] p-2.5 border border-[#00FFD1]/40 rounded-full backdrop-blur-md hover:scale-105 active:scale-95 transition-all flex items-center justify-center cursor-pointer group select-none pointer-events-auto"
          title="Open Navigation Menu"
        >
          <MenuIcon size={24} className="text-white group-hover:rotate-12 transition-transform duration-300" />
        </button>
      )}

      {/* Floating Top Nav */}
      <AnimatePresence>
        {(!gameInSession || view === "neonconnect" || view === "chess") && (
          <motion.div
            initial={{ y: -100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -100, opacity: 0 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="fixed top-6 left-0 right-0 z-50 flex flex-col items-center gap-3 px-4 pointer-events-none"
          >
            <nav className="relative flex items-center w-full max-w-5xl shadow-2xl rounded-full pointer-events-auto">
              <GlassPanel
                variant="md"
                radius={999}
                className="absolute inset-0 pointer-events-none"
                style={{
                  filter: "url(#liquid-glass)",
                  transform: "scale(1.05)",
                }}
              />

              <div className="relative z-10 flex w-full items-center gap-2 md:gap-4 p-2 pl-4 md:pl-6 border border-[#00FFD1]/40 rounded-full transition-all duration-500">
                {/* Logo */}
                <div
                  className="flex items-center gap-2 mr-auto cursor-pointer"
                  onClick={navigateToLanding}
                >
                  <img src="/NeonArcadeLogo.png" alt="Neon Arcade Logo" className="h-6 md:h-8 w-auto object-contain drop-shadow-[0_0_8px_rgba(0,255,209,0.5)]" />
                  <span className="text-white font-black italic tracking-tighter text-sm md:text-lg uppercase neon-text-glow whitespace-nowrap">
                    NEON ARCADE
                  </span>
                </div>

                {/* Desktop Links */}
                <div className="hidden md:flex items-center gap-1">
                  <button
                    onClick={navigateToLanding}
                    className={`flex items-center gap-2 px-3 md:px-4 py-2 rounded-full transition-all text-xs md:text-sm font-medium ${
                      view === "landing"
                        ? "text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]"
                        : "text-white/60 hover:text-white"
                    }`}
                  >
                    <Compass className="w-4 h-4" />
                    <span className="hidden lg:inline">Main Menu</span>
                  </button>
                  <button
                    onClick={handlePlayNow}
                    className={`flex items-center gap-2 px-3 md:px-4 py-2 rounded-full transition-all text-xs md:text-sm font-medium ${
                      view === "arcade"
                        ? "text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]"
                        : "text-white/60 hover:text-white"
                    }`}
                  >
                    <Gamepad2 className="w-4 h-4" />
                    <span className="hidden lg:inline">Library</span>
                  </button>
                </div>

                {/* Profile Quick Access */}
                {profile && (
                  <div
                    onClick={() => setShowSettings(true)}
                    className="flex items-center gap-3 px-4 py-2 border-l border-white/10 cursor-pointer group hover:bg-white/5 transition-colors rounded-full"
                  >
                    <div className="w-8 h-8 rounded-full bg-white/5 overflow-hidden border border-[#00FFD1]/40 group-hover:scale-110 transition-transform flex items-center justify-center relative z-20">
                      {profile.avatarUrl &&
                      profile.avatarUrl !==
                        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" ? (
                        <img
                          src={profile.avatarUrl}
                          alt={profile.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <User className="w-4 h-4 text-[#00FFD1]" />
                      )}
                    </div>
                    <span className="text-xs font-black text-white italic uppercase tracking-tighter hidden sm:block">
                      {profile.name}
                    </span>
                  </div>
                )}

                {/* Notification Bell Icon & Daily Reward Dropdown */}
                <div className="relative z-30" ref={notificationRef}>
                  <button
                    onClick={() => setShowNotifications(!showNotifications)}
                    className="p-2.5 border border-white/10 hover:border-[#00FFD1]/50 hover:bg-[#00FFD1]/10 rounded-full transition-all flex items-center justify-center relative cursor-pointer group pointer-events-auto"
                    title="System Notifications"
                  >
                    <Bell className="w-4 h-4 text-white group-hover:text-[#00FFD1] transition-colors" />
                    {dailyAvailable && (
                      <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-rose-500 rounded-full animate-ping shadow-[0_0_10px_#f43f5e]" />
                    )}
                    {dailyAvailable && (
                      <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-rose-500 rounded-full shadow-[0_0_8px_#f43f5e]" />
                    )}
                  </button>

                  <AnimatePresence>
                    {showNotifications && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 10 }}
                        className="absolute right-0 mt-3 w-82 bg-[#081616]/98 border border-[#00FFD1]/40 rounded-2xl p-4 shadow-[0_0_50px_rgba(0,255,209,0.15)] backdrop-blur-xl z-[100] text-left font-mono space-y-4"
                      >
                        <div className="flex items-center justify-between border-b border-[#00FFD1]/20 pb-2">
                          <span className="text-[10px] text-[#00FFD1] font-black uppercase tracking-wider flex items-center gap-1.5 animate-pulse">
                            <Sparkles className="w-3.5 h-3.5" /> System Feeds
                          </span>
                          <span className="text-[8px] text-white/30 uppercase flex items-center gap-0">
                            Wallet: <img src="/neon-bucks-icon.png" alt="NB" referrerPolicy="no-referrer" className="h-4 w-auto inline-block drop-shadow-[0_0_5px_rgba(0,255,209,0.5)] -mr-0.5" /> {balance}
                          </span>
                        </div>

                        <div className="space-y-3">
                          {/* Daily Reward Row */}
                          <div className={`p-2 rounded-xl border transition-all ${
                            dailyAvailable 
                              ? 'border-[#00FFD1]/30 bg-[#00FFD1]/5 hover:bg-[#00FFD1]/10' 
                              : 'border-white/5 bg-white/2'
                          }`}>
                            <div className="flex items-center gap-2.5">
                              <div className={`w-10 h-10 rounded-xl shrink-0 flex items-center justify-center ${
                                dailyAvailable ? 'bg-[#00FFD1]/20 text-[#00FFD1]' : 'bg-white/5 text-white/30'
                              }`}>
                                <Gift className={`w-4 h-4 ${dailyAvailable ? 'animate-bounce' : ''}`} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <h5 className={`text-[11px] font-black uppercase tracking-wider leading-none ${
                                  dailyAvailable ? 'text-[#00FFD1]' : 'text-white/60'
                                }`}>
                                  Daily Reward
                                </h5>
                                <p className="text-[8px] text-white/40 uppercase tracking-widest mt-1 truncate">
                                  {dailyAvailable 
                                    ? "20 Neon Bucks ready"
                                    : "Claimed today"
                                  }
                                </p>
                              </div>
                              
                              <div className="shrink-0">
                                {dailyAvailable ? (
                                  <button
                                    onClick={handleClaimDaily}
                                    className="px-3 py-1.5 bg-[#00FFD1] hover:bg-[#00e0b7] text-[#081616] font-black text-[9px] uppercase tracking-wider rounded-full transition-transform hover:scale-[1.02] active:scale-95 cursor-pointer shadow-[0_0_10px_rgba(0,255,209,0.3)] pointer-events-auto"
                                  >
                                    Claim
                                  </button>
                                ) : (
                                  <div className="flex items-center gap-0.5 text-[8px] text-[#00FFD1] font-bold uppercase mr-1">
                                    <Check className="w-3 h-3 animate-pulse" /> Done
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Welcome System Notification */}
                          <div className="p-2.5 rounded-xl border border-white/5 bg-white/2">
                            <div className="flex gap-3">
                              <div className="w-10 h-10 rounded-xl bg-cyan-500/10 text-[#00FFD1] shrink-0 flex items-center justify-center">
                                <Sparkles className="w-4 h-4" />
                              </div>
                              <div className="space-y-1 flex-1">
                                <h5 className="text-xs font-black text-white/80 uppercase">
                                  Arcade Welcome
                                </h5>
                                <p className="text-[9px] text-white/40 leading-relaxed uppercase tracking-wider">
                                  Welcome to Neon Arcade! Play matches using Neon Bucks. Double your stake in Slayer or Snake formats.
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="text-[8px] text-center text-white/20 uppercase tracking-widest border-t border-white/5 pt-2">
                          Secure Blockchain Sync Ready
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Logged out → "Connect" opens the Privy login modal.
                    Logged in → "Wallet" opens the embedded-wallet panel
                    (address + SOL balance + export/disconnect). */}
                {authenticated ? (
                  <button
                    onClick={() => setShowWallet(true)}
                    title="Open your wallet"
                    className="flex items-center gap-2 bg-gradient-to-r from-[#00FFD1] to-[#00e0b7] text-[#00382c] px-4 md:px-5 py-2 md:py-2.5 rounded-full font-bold text-[10px] md:text-sm transition-all shadow-[0_0_40px_rgba(0,255,209,0.5)] hover:scale-105 active:scale-95 ml-1 md:ml-2 relative z-20 cursor-pointer"
                  >
                    <Wallet className="w-3 h-3 md:w-4 md:h-4 fill-current" />
                    <span className="whitespace-nowrap">Wallet</span>
                  </button>
                ) : (
                  <button
                    // Gated: Privy popup now, username + PIN + authenticator
                    // right after sign-in (stays on the current page).
                    onClick={() => requireAccount(view)}
                    title="Log in"
                    className="flex items-center gap-2 bg-gradient-to-r from-[#00FFD1] to-[#00e0b7] text-[#00382c] px-4 md:px-5 py-2 md:py-2.5 rounded-full font-bold text-[10px] md:text-sm transition-all shadow-[0_0_40px_rgba(0,255,209,0.5)] hover:scale-105 active:scale-95 ml-1 md:ml-2 relative z-20 cursor-pointer"
                  >
                    <Wallet className="w-3 h-3 md:w-4 md:h-4 fill-current" />
                    <span className="whitespace-nowrap">Connect</span>
                  </button>
                )}
              </div>
            </nav>
            <AnimatePresence>
              {view !== "landing" && view !== "account_setup" && !gameInSession && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="pointer-events-auto mt-2 z-40"
                >
                  <ActiveUsers realCount={connected ? activeUsers : 0} label="online" variant="mini" />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSettings && profile && (
          <ProfileSettings
            currentProfile={profile}
            onUpdate={handleProfileUpdate}
            onClose={() => setShowSettings(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showWallet && authenticated && (
          <WalletPanel
            profile={profile}
            onClose={() => setShowWallet(false)}
            onDisconnect={handleDisconnectWallet}
          />
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {view === "landing" ? (
          <motion.div
            key="landing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <LandingView
              onExplore={() => setView("arcade")}
              onPlayNow={handlePlayNow}
              activeUsers={connected ? activeUsers : 0}
            />
          </motion.div>
        ) : view === "account_setup" ? (
          <motion.div
            key="account_setup"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <AccountSetup onComplete={handleAccountComplete} />
          </motion.div>
        ) : view === "arcade" ? (
          <motion.div
            key="arcade"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            {/* Every tile routes through requireAccount: signed-out users
                get the Privy popup (then username + PIN + authenticator)
                before any game opens. */}
            <ArcadeView
              onBack={navigateToLanding}
              onSelectNeonConnect={() => requireAccount("neonconnect")}
              onSelectChess={() => requireAccount("chess")}
              onSelectVolley={() => requireAccount("volley")}
              onSelectCells={() => requireAccount("cells")}
              onSelectAsteroids={() => requireAccount("asteroids")}
              onSelectTrivia={() => requireAccount("trivia")}
              onSelectGolf={() => requireAccount("golf")}
              onSelectClumsy={() => requireAccount("clumsy")}
              onSelectKiller={() => requireAccount("killer")}
              onSelectPugShooter={() => requireAccount("pugshooter")}
              masterVolume={masterVolume}
              onVolumeChange={handleVolumeChange}
              showVolumeConfig={showVolumeConfig}
              onToggleVolumeConfig={() => setShowVolumeConfig(!showVolumeConfig)}
            />
          </motion.div>
        ) : view === "neonconnect" ? (
          <motion.div
            key="neonconnect"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <NeonConnectGame
              onExit={() => {
                setView("arcade");
                setGameInSession(false);
              }}
              profile={profile}
              onGameStatusChange={setGameInSession}
            />
          </motion.div>
        ) : view === "chess" ? (
          <motion.div
            key="chess"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <ChessGame 
              onExit={() => {
                setView("arcade");
                setGameInSession(false);
              }} 
              profile={profile} 
              onGameStatusChange={setGameInSession}
            />
          </motion.div>
        ) : view === "volley" ? (
          <motion.div
            key="volley"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <VolleyGame
              onExit={() => {
                setView("arcade");
                setGameInSession(false);
              }}
              profile={profile}
              onGameStatusChange={setGameInSession}
            />
          </motion.div>
        ) : view === "cells" ? (
          <motion.div
            key="cells"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <CellsGame onExit={() => setView("arcade")} profile={profile} />
          </motion.div>
        ) : view === "trivia" ? (
          <motion.div
            key="trivia"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <TriviaGame
              onExit={() => {
                setView("arcade");
                setGameInSession(false);
              }}
              profile={profile}
              onGameStatusChange={setGameInSession}
            />
          </motion.div>

        ) : view === "golf" ? (
          <motion.div
            key="golf"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <GolfGame
              onExit={() => {
                setView("arcade");
                setGameInSession(false);
              }}
              profile={profile}
              onGameStatusChange={setGameInSession}
            />
          </motion.div>
        ) : view === "clumsy" ? (
          <motion.div
            key="clumsy"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <ClumsyGame
              onExit={() => {
                setView("arcade");
                setGameInSession(false);
              }}
              profile={profile}
              onGameStatusChange={setGameInSession}
            />
          </motion.div>
        ) : view === "killer" ? (
          <motion.div
            key="killer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <KillerGame
              onExit={() => {
                setView("arcade");
                setGameInSession(false);
              }}
              profile={profile}
              onGameStatusChange={setGameInSession}
            />
          </motion.div>
        ) : view === "pugshooter" ? (
          <motion.div
            key="pugshooter"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <PugShooterGame
              onExit={() => {
                setView("arcade");
                setGameInSession(false);
              }}
              profile={profile}
              onGameStatusChange={setGameInSession}
            />
          </motion.div>
        ) : (
          <motion.div
            key="asteroids"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <AsteroidsGame
              onExit={() => {
                setView("arcade");
                setGameInSession(false);
              }}
              profile={profile}
              onGameStatusChange={setGameInSession}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer (Shared) */}
      {view !== "asteroids" && view !== "cells" && view !== "volley" && view !== "chess" && view !== "golf" && view !== "clumsy" && view !== "killer" && view !== "pugshooter" && (
        <footer className="fixed bottom-0 left-0 right-0 z-50 flex justify-center gap-8 py-6 w-full bg-transparent font-mono text-[10px] tracking-[0.3em] text-[#00FFD1]/40 pointer-events-none">
          <span className="uppercase">© 2026 NeonArcade Gaming</span>
          <div className="hidden md:flex gap-8 pointer-events-auto">
            <a
              className="hover:text-[#00FFD1] transition-colors uppercase"
              href="#"
            >
              Protocol
            </a>
            <a
              className="hover:text-[#00FFD1] transition-colors uppercase"
              href="#"
            >
              Data Stream
            </a>
            <a
              className="hover:text-[#00FFD1] transition-colors uppercase"
              href="#"
            >
              Frequency
            </a>
          </div>
        </footer>
      )}
    </div>
  );
}

function LandingView({
  onExplore,
  onPlayNow,
  activeUsers,
}: {
  onExplore: () => void;
  onPlayNow: () => void;
  activeUsers: number;
}) {
  return (
    <>
      {/* Background */}
      <div className="fixed inset-0 z-0 bg-[#081616]">
        <SafeErrorBoundary>
          <CursorBlob3D />
        </SafeErrorBoundary>
        <CursorGlow />
        <SafeErrorBoundary>
          <SplashCursor
            DENSITY_DISSIPATION={2}
            VELOCITY_DISSIPATION={3.5}
            PRESSURE={0.45}
            SPLAT_RADIUS={0.47}
            SPLAT_FORCE={17000}
            COLOR="#00FFEA"
            RAINBOW_MODE={false}
            zIndex={1}
            position="absolute"
          />
        </SafeErrorBoundary>
        <GlassPanel
          variant="md"
          radius={0}
          style={{ position: "absolute", inset: 0, zIndex: 2, border: "none", boxShadow: "none" }}
        >
          <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/80" />
        </GlassPanel>
      </div>

      <main className="relative z-10 h-full flex flex-col items-center justify-center text-center px-6 pt-24 pb-20">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 1, delay: 0.2 }}
          className="max-w-5xl w-full"
        >
          <h1 className="text-5xl sm:text-7xl md:text-9xl font-black italic tracking-tighter text-white mb-6 neon-text-glow leading-none uppercase [&_.focus-word:nth-child(5)]:text-[#00FFD1] [&_.focus-word:nth-child(5)]:[-webkit-text-stroke:2px_black] [&_.focus-container]:gap-0 [&_.focus-word]:leading-[0.6] [&_.focus-word:nth-child(5)]:-mt-12 sm:[&_.focus-word:nth-child(5)]:-mt-16 md:[&_.focus-word:nth-child(5)]:-mt-24 [&_.focus-word:nth-child(5)]:-translate-y-[20px] [&_.focus-container>*:nth-child(-n+3)]:translate-y-[45px] sm:[&_.focus-container>*:nth-child(-n+3)]:translate-y-[75px] md:[&_.focus-container>*:nth-child(-n+3)]:translate-y-[115px]">
            <TrueFocus 
              sentence="SKILL - BASED <br/> BETTING"
              manualMode={false}
              blurAmount={5}
              borderColor="#00ffd1"
              animationDuration={2}
              pauseBetweenAnimations={1}
            />
          </h1>

          <motion.p
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.5 }}
            className="text-lg sm:text-xl md:text-2xl text-white/80 font-light tracking-[0.2em] mb-10 md:mb-12 uppercase drop-shadow-lg px-4"
          >
            Experience the next evolution of gaming
          </motion.p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 md:gap-6 mb-12 md:mb-16">
            <button
              onClick={onPlayNow}
              className="w-full sm:w-auto group relative px-8 md:px-10 py-4 md:py-5 bg-gradient-to-r from-[#00FFD1] to-[#00e0b7] text-[#00382c] font-black uppercase tracking-[0.3em] rounded-full overflow-hidden transition-all hover:scale-105 active:scale-95 shadow-[0_0_40px_rgba(0,255,209,0.5)] cursor-pointer"
            >
              Play Now
            </button>
            <button
              onClick={onExplore}
              className="w-full sm:w-auto px-8 md:px-10 py-4 md:py-5 border border-[#00FFD1]/40 text-white font-black uppercase tracking-[0.3em] rounded-full backdrop-blur-md transition-all hover:scale-105 active:scale-95 select-none cursor-pointer"
            >
              Explore Games
            </button>
          </div>
        </motion.div>

        {/* Stats Bar */}
        <motion.div
          initial={{ y: 50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.8 }}
          className="w-full max-w-4xl"
        >
          <div className="relative rounded-2xl overflow-hidden shadow-2xl">
            <GlassPanel
              variant="md"
              radius={16}
              className="absolute inset-0 pointer-events-none"
              style={{ filter: "url(#liquid-glass)", transform: "scale(1.05)" }}
            />

            <div className="relative z-10 p-6 md:p-8 flex flex-col sm:flex-row justify-around items-center gap-6 sm:gap-0 border border-[#00FFD1]/40 rounded-2xl transition-all duration-500 backdrop-blur-md">
              <ActiveUsers realCount={activeUsers} label="Active Users" />
              <div className="hidden sm:block w-px h-10 bg-[#00FFD1]/40"></div>
              <Stat 
                value={
                  <div className="flex items-center gap-1.5 -translate-x-0.5">
                    <img src="/solana-sol-icon.svg" alt="SOL" className="h-5 md:h-6 w-auto" />
                    <span>0</span>
                  </div>
                } 
                label="Player Earnings" 
              />
              <div className="hidden sm:block w-px h-10 bg-[#00FFD1]/40"></div>
              <Stat value="6" label="Exclusive Titles" />
            </div>
          </div>
        </motion.div>
      </main>
    </>
  );
}

function ArcadeView({
  onBack,
  onSelectNeonConnect,
  onSelectChess,
  onSelectVolley,
  onSelectCells,
  onSelectAsteroids,
  onSelectTrivia,
  onSelectGolf,
  onSelectClumsy,
  onSelectKiller,
  onSelectPugShooter,
  masterVolume,
  onVolumeChange,
  showVolumeConfig,
  onToggleVolumeConfig,
}: {
  onBack: () => void;
  onSelectNeonConnect: () => void;
  onSelectChess: () => void;
  onSelectVolley: () => void;
  onSelectCells: () => void;
  onSelectAsteroids: () => void;
  onSelectTrivia: () => void;
  onSelectGolf: () => void;
  onSelectClumsy: () => void;
  onSelectKiller: () => void;
  onSelectPugShooter: () => void;
  masterVolume: number;
  onVolumeChange: (vol: number) => void;
  showVolumeConfig: boolean;
  onToggleVolumeConfig: () => void;
}) {
  const gridRef = React.useRef<HTMLDivElement>(null);

  return (
    <div className="relative h-full w-full flex flex-col items-center justify-center overflow-auto pt-28 pb-24">
      {/* Dark Background */}
      <div className="fixed inset-0 z-0 bg-[#081616]">
        <LibraryBlob />
        <div className="absolute inset-0 bg-gradient-to-t from-[#081616] via-transparent to-[#081616]/50"></div>
      </div>

      <GlobalSpotlight gridRef={gridRef} />

      <main className="relative z-10 w-full max-w-7xl px-6 md:px-8 flex flex-col items-center translate-y-[40px]">
        <div ref={gridRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6 w-full bento-section">
          <MagicBentoGameTile
            onClick={onSelectNeonConnect}
            icon={
              <div className="grid grid-cols-2 gap-2">
                <div className="w-4 h-4 rounded-full bg-[#00FFD1] shadow-[0_0_10px_#00FFD1]" />
                <div className="w-4 h-4 rounded-full border border-[#00FFD1]/40" />
                <div className="w-4 h-4 rounded-full border border-[#00FFD1]/40" />
                <div className="w-4 h-4 rounded-full bg-[#00FFD1] shadow-[0_0_10px_#00FFD1]" />
              </div>
            }
            title="Neon Connect"
          />
          <MagicBentoGameTile
            onClick={onSelectChess}
            icon={<Swords className="w-12 h-12" />}
            title="Neon Chess"
          />
          <MagicBentoGameTile
            onClick={onSelectVolley}
            icon={
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <rect x="4" y="19" width="16" height="2" rx="1" />
                <circle cx="12" cy="11" r="3" />
                <path
                  d="M10 9 C 7 5, 5 2, 4 0 C 8 3, 10 6, 11 9 Z"
                  opacity="0.7"
                />
                <path
                  d="M14 9 C 17 5, 19 2, 20 0 C 16 3, 14 6, 13 9 Z"
                  opacity="0.7"
                />
                <path
                  d="M12 8 C 12 4, 12 1, 12 -1 C 13 1, 13 4, 12 8 Z"
                  opacity="0.5"
                />
              </svg>
            }
            title="Neon Volley"
          />
          <MagicBentoGameTile
            onClick={onSelectCells}
            icon={<Orbit className="w-12 h-12" />}
            title="Neon Cells"
          />
          <MagicBentoGameTile
            onClick={onSelectAsteroids}
            icon={<Rocket className="w-12 h-12 text-[#00FFD1] -rotate-45" />}
            title="Neon Asteroids"
          />
          <MagicBentoGameTile
            onClick={onSelectTrivia}
            icon={<Brain className="w-12 h-12 text-[#00FFD1]" />}
            title="Neon Quiz"
          />
          <div className="lg:col-start-1">
            <MagicBentoGameTile
              onClick={onSelectGolf}
              icon={<FlagTriangleRight className="w-12 h-12 text-[#00FFD1]" />}
              title="Neon Golf Clash"
            />
          </div>
          <div className="lg:col-start-2">
            <MagicBentoGameTile
              onClick={onSelectClumsy}
              icon={<Ghost className="w-12 h-12 text-[#00FFD1]" />}
              title="Neon Clumsy"
            />
          </div>
          <div className="lg:col-start-3">
            <MagicBentoGameTile
              onClick={onSelectKiller}
              icon={<Skull className="w-12 h-12 text-[#00FFD1]" />}
              title="Neon Killer"
            />
          </div>
          <div className="lg:col-start-1">
            <MagicBentoGameTile
              onClick={onSelectPugShooter}
              icon={<Crosshair className="w-12 h-12 text-[#00FFD1]" />}
              title="Neon Pug Shooter"
            />
          </div>
        </div>
      </main>

      {/* Floating Settings Button in the bottom right of the library (ArcadeView) */}
      <div className="fixed bottom-8 right-8 z-[50]">
        <button
          onClick={onToggleVolumeConfig}
          className="p-4 rounded-full border border-[#00FFD1]/40 hover:scale-105 active:scale-95 transition-all flex items-center justify-center cursor-pointer select-none backdrop-blur-md"
          title="Configure Master Volume"
        >
          <Settings className="w-6 h-6 animate-spin-slow text-white" />
        </button>

        <AnimatePresence>
          {showVolumeConfig && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 10 }}
              className="absolute bottom-20 right-0 w-64 bg-black/95 border border-[#00FFD1]/40 rounded-2xl p-6 shadow-2xl backdrop-blur-xl z-[60] space-y-4 text-left font-mono"
            >
              <h4 className="text-white font-black uppercase text-xs tracking-wider">
                System Options
              </h4>
              <div className="space-y-2">
                <div className="flex justify-between text-[10px] uppercase text-white/50">
                  <span>Master Volume</span>
                  <span>{Math.round(masterVolume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={masterVolume}
                  onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                  className="w-full accent-[#00FFD1] bg-[#111E1E] rounded-lg appearance-none h-1 cursor-pointer"
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="text-center flex flex-col items-center">
      <div className="text-[#00FFD1] text-2xl md:text-3xl font-bold tracking-tighter flex items-center justify-center gap-1">
        {value}
      </div>
      <div className="text-[8px] md:text-[10px] uppercase tracking-[0.2em] text-[#83958D] mt-1">
        {label}
      </div>
    </div>
  );
}
