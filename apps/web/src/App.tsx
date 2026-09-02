import React from "react";
import { motion, AnimatePresence } from "motion/react";
// Only what this file actually renders. The nine game-tile glyphs moved to
// components/glass/gameIcons.tsx with the catalog-driven grid, and roughly a
// dozen more (Activity, BarChart3, Trophy, Flame, Clock, …) were already dead
// imports that lucide-react was still being asked to resolve.
import {
  Compass,
  Gamepad2,
  User,
  Wallet,
  Menu as MenuIcon,
} from "lucide-react";
import { Howler } from "howler";
import { useQueryClient } from "@tanstack/react-query";

import { useNeonBucks } from "./NeonBucksStore";
import { useCurrency } from "./CurrencyStore";
// Lazy: AccountSetup is a full-screen view reached only through the sign-in
// gate, but as a static import its ~400 lines shipped in the entry chunk
// every visitor downloads before first paint.
const AccountSetup = React.lazy(() =>
  import("./components/AccountSetup").then((m) => ({ default: m.AccountSetup })),
);
import { ProfileSettings } from "./components/ProfileSettings";
import { GameChunkLoading } from "./components/common/GameChunkLoading";
// Mid-match "are you sure? leaving forfeits" — a live game registers the
// guard; with none registered these navigations run exactly as before.
import { navigateWithExitGuard } from "./components/common/exitGuard";

// ---------------------------------------------------------------------------
// GAMES ARE CODE-SPLIT, ALL NINE OF THEM
// ---------------------------------------------------------------------------
// These were static imports, which meant the landing page downloaded and parsed
// every game before it could paint — Asteroids' 3k-line canvas core, the chess
// engine glue, Cells, Volley, Trivia, and every iframe wrapper — for a visitor
// who had not chosen anything yet.
//
// `React.lazy` gives each game its own chunk, fetched the first time that view
// opens and cached by the browser afterwards. App.tsx renders exactly one game
// at a time in the ternary below, so leaving a game still unmounts it and stops
// its work; lazy only changes WHEN the code arrives, never whether it is freed.
//
// Each one is wrapped in <Suspense fallback={<GameChunkLoading …/>}> at its use
// site rather than around the whole AnimatePresence — a fallback hoisted above
// AnimatePresence would blow away the view-transition animation.
const NeonConnectGame = React.lazy(() => import("./components/NeonConnect/NeonConnectGame"));
const ChessGame = React.lazy(() => import("./components/Chess/ChessGame"));
const VolleyGame = React.lazy(() => import("./components/Volley/VolleyGame"));
const CellsGame = React.lazy(() => import("./components/Cells/CellsGame"));
const AsteroidsGame = React.lazy(() => import("./components/Asteroids/AsteroidsGame"));
const NeonKickoffGame = React.lazy(() => import("./components/neonKickoff/NeonKickoffGame"));
const GolfGame = React.lazy(() => import("./components/Golf/GolfGame"));
const ClumsyGame = React.lazy(() => import("./components/Clumsy/ClumsyGame"));
const PugShooterGame = React.lazy(() => import("./components/PugShooter/PugShooterGame"));

import { disconnectGameSocket } from "./hooks/useGameSocket";

// ---------------------------------------------------------------------------
// NOTIFICATIONS
// ---------------------------------------------------------------------------
// The store itself is mounted above <App/> in main.tsx; these are the three
// pieces that live in the app tree:
//
//   useNotifications          mid-match suppression + the sidebar handoff
//   NotificationCenter        the nav-bar bell and its dropdown (eager: the
//                             badge has to be right on first paint)
//   NotificationsSocketBridge the ONE socket listener, gated on an account
//   NotificationToasts        the in-app pop-up stack
//
// The bridge and the toasts are LAZY for the same reason PrivateWagerHost is:
// the bridge reaches the private-wager catalog and the toasts are pure
// decoration until something actually happens. The centre is not — a stale
// bell is worse than a few kB.
import { useNotifications } from "./notifications/NotificationsStore";
import { NotificationCenter } from "./notifications/NotificationCenter";
import { useGlobalFullscreenKey, FullscreenButton } from "./components/common/fullscreen";
const NotificationsSocketBridge = React.lazy(() =>
  import("./notifications/NotificationsSocketBridge").then((m) => ({
    default: m.NotificationsSocketBridge,
  })),
);
const NotificationToasts = React.lazy(() =>
  import("./notifications/NotificationToasts").then((m) => ({
    default: m.NotificationToasts,
  })),
);

// LAZY. The sidebar is a closed drawer on arrival, but it reads the live SOL
// balance — so it static-imported lib/solana → @solana/kit, which put the
// whole Solana codec tree in the entry graph (and, grouped with the wallet
// SDK, made the browser modulepreload 3.7 MB before first paint). Rendering
// it lazily takes that off the critical path; it still mounts instantly on
// the first open because the chunk is warmed alongside the library.
const SidebarMenu = React.lazy(() =>
  import("./components/SidebarMenu").then((m) => ({ default: m.SidebarMenu })),
);
// Mounted ONCE, app-wide (see below): the private-wager game/mode picker the
// sidebar's hover-invite opens, plus the ACCEPT/LATER toasts for incoming
// `private:invited` pushes. Renders nothing until one of those happens.
// LAZY, and for a non-obvious reason: PrivateWagerRoom → PrivateWagerInvite
// static-imports Cells/CellsDifficultySelector and Asteroids/AsteroidsDifficulty-
// Selector (it renders each game's own mode picker in the invite flow). Eagerly
// importing the host therefore dragged ~35 kB of *game-directory* code into the
// landing page's entry chunk — the one thing the code-splitting above exists to
// prevent. The render gate below (`hasAccount &&`) gates rendering, not download;
// only React.lazy does that.
const PrivateWagerHost = React.lazy(() =>
  import("./components/social/PrivateWagerRoom").then((m) => ({ default: m.PrivateWagerHost })),
);

import { LiquidFilter } from "./components/glass/LiquidFilter";
import { CursorGlow } from "./components/glass/CursorGlow";
import { GlassPanel } from "./components/glass/GlassPanel";
// THE LIBRARY IS LAZY TOO, and not only because it's a separate screen: it is
// the sole owner of `ogl` (the WebGL blob behind the grid) and `gsap` (the
// tile tilt/particle effects) on the landing path. As a static import those
// two libraries sat in the entry chunk for every visitor, including ones who
// never leave the landing page. See components/ArcadeView.tsx.
const ArcadeView = React.lazy(() => import("./components/ArcadeView"));
// The mobile allow-list and the nav title read the same catalog the library
// grid does — see lib/games.ts for why the categories are what they are.
import { GAME_TITLES, isPlayableOnMobile } from "./lib/games";
import { useDevice } from "./hooks/useIsMobile";
// LANDING-ONLY WEBGL DECORATION, ALSO SPLIT OUT.
// These two are the reason three.js + @react-three/fiber and a 1100-line fluid
// simulation were in the entry chunk — the single biggest thing standing between
// a visitor and a painted home page, for two effects that are purely cosmetic.
// Lazy + `fallback={null}` means the landing renders immediately and the blob /
// splash fade in a beat later; nothing else in the app references them.
const CursorBlob3D = React.lazy(() =>
  import("./components/glass/CursorBlob3D").then((m) => ({ default: m.CursorBlob3D })),
);
const SplashCursor = React.lazy(() =>
  import("./components/SplashCursor").then((m) => ({ default: m.SplashCursor })),
);
import { NeonViewportGlow } from "./components/NeonViewportGlow";
import { SafeErrorBoundary } from "./components/SafeErrorBoundary";
import ActiveUsers from "./components/ActiveUsers";
import { useActiveUsers } from "./hooks/useActiveUsers";
import ParticleText from "./components/ParticleText";
import TargetCursor from "./components/TargetCursor";
import type { PrivateGameKey } from "./components/social/privateWagerCatalog";
import { hasChosenRegion, setRegion } from "./lib/region";
import Particles from "./components/glass/Particles";

// Auth comes from our own deferred context, not from Privy's hooks — the SDK
// is fetched on idle and mounted outside this tree so it can't block first
// paint. src/auth/index.tsx explains the arrangement.
import { useAuth, useOnLoginComplete, prefetchAuth } from "./auth";
import { refreshSession, endSession, AUTH_TOKEN_KEY } from "./hooks/useBackendAuth";
// LAZY for the same reason as SidebarMenu: it's a modal that nobody has
// opened yet, and it reaches @solana/kit for the balance readout.
const WalletPanel = React.lazy(() =>
  import("./components/WalletPanel").then((m) => ({ default: m.WalletPanel })),
);
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
  | "kickoff"
  | "golf"
  | "clumsy"
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

/**
 * Private-wager `gameKey` → the arcade view that hosts it.
 *
 * The keys mirror the private-wager catalog (and the server's CATALOG); the
 * values are this file's own `View` union. Only "connect" differs by name, and
 * that mismatch is exactly why this table exists rather than a cast.
 */
const PRIVATE_WAGER_VIEWS: Record<string, View> = {
  chess: "chess",
  connect: "neonconnect",
  volley: "volley",
  kickoff: "kickoff",
  cells: "cells",
  asteroids: "asteroids",
  golf: "golf",
  clumsy: "clumsy",
  pugshooter: "pugshooter",
};

export default function App() {
  const { activeUsers, connected } = useActiveUsers();
  // isTouch gates which games exist for this visitor; isNarrow gates layout.
  // See hooks/useIsMobile.ts for why those are two different questions.
  const { isTouch, isNarrow } = useDevice();

  // Privy session + the bridge that turns it into our backend JWT.
  // `authLoaded` is new: it's false for the brief window between first paint
  // and the auth chunk arriving, during which `ready` is also false but for a
  // different reason — nothing is wrong, the SDK simply isn't up yet.
  const {
    loaded: authLoaded,
    ready: privyReady,
    authenticated,
    wallets,
    login,
    logout,
  } = useAuth();

  // The Create Account panel opens the moment Privy sign-on completes —
  // not after the wallet appears and the backend signature exchange
  // lands. AccountSetup itself shows the wallet/signature progress and
  // self-dismisses for accounts that are already complete, so following
  // up unconditionally is safe.
  useOnLoginComplete(() => {
    setGameInSession(false);
    setView("account_setup");
  });
  // Sign-out goes through `endSession()` rather than the hook's
  // `clearSession()`: the token has to be REVOKED on the server before it
  // is thrown away locally, or every other copy of it stays live for the
  // rest of its 30 days. See handleDisconnectWallet.
  // "Already auto-followed-up once this session" — restored sessions get
  // one automatic push into Create Account; after that the gates
  // (Connect / Play Now / tiles) take over.
  const autoFollowUpDone = React.useRef(false);

  const { win, balance } = useNeonBucks();
  // Only used to EVICT on sign-out (see handleDisconnectWallet) — App itself
  // runs no queries.
  const queryClient = useQueryClient();
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

  // THE 'f' fullscreen keybind — one listener for the whole arcade (the
  // per-game copies were removed; see components/common/fullscreen.tsx).
  useGlobalFullscreenKey();
  const [masterVolume, setMasterVolume] = React.useState<number>(() => {
    const saved = localStorage.getItem("masterVolume");
    return saved !== null ? parseFloat(saved) : 0.5;
  });
  const [showVolumeConfig, setShowVolumeConfig] = React.useState(false);

  // NOTIFICATIONS. The bell (and its outside-click handling) now lives in
  // <NotificationCenter/>; App only owns the two things the centre can't:
  // whether a match is running, and which sidebar panel a row should open.
  // `clearAll` is only used on sign-out: notifications are addressed to the
  // account that just left, so they must not survive into the next one.
  const { setInGame: setNotificationsInGame, clearAll: clearNotifications, armJoin } =
    useNotifications();

  /**
   * "Open the drawer on THIS panel" — set by a notification row just before
   * the drawer is opened. Cleared when the drawer closes, never while it is
   * open (SidebarMenu only reads it on the closed→open edge, so clearing it
   * mid-flight would bounce the user back to the menu).
   */
  const [sidebarTarget, setSidebarTarget] = React.useState<
    {
      panel: "friends" | "messages" | "history" | "leaderboard" | "stats";
      username?: string;
    } | null
  >(null);

  const openSidebarPanel = React.useCallback(
    (panel: "friends" | "messages", username?: string) => {
      setSidebarTarget({ panel, username });
      setMenuOpen(true);
    },
    []
  );

  const closeSidebar = React.useCallback(() => {
    setMenuOpen(false);
    setSidebarTarget(null);
  }, []);

  /**
   * ACCEPTING AN INVITE HAS TO GET YOU TO THE GAME.
   *
   * A private room does not run the game — when everyone is ready the server
   * drives each player's normal matchmaking and the game's OWN start event
   * lands a tick later. A room opened from a lobby is already standing on that
   * screen, so something is listening. A room opened from the nav-bar bell is
   * not: the invitee could be on the landing page, and the match would start
   * with nobody home.
   *
   * So the arcade navigates to the invited game BEFORE the waiting room opens.
   * Returns a REASON string when it refuses (null when it navigated), and
   * `PrivateWagerHost` shows that reason rather than opening a room the player
   * cannot play — leaving the invite in the bell so they can take it later.
   *
   * TWO refusals:
   *   MID-MATCH  navigating would unmount a live game. The server-side match
   *              keeps running, so the player would simply stop playing one
   *              they cannot get back to — and lose it. Never worth an invite.
   *   DEVICE     the same gate `requireAccount` applies, so a phone cannot be
   *              dropped into a keyboard-only game by accepting an invite.
   */
  const openGameForPrivateWager = React.useCallback(
    (gameKey: string): string | null => {
      const dest = PRIVATE_WAGER_VIEWS[gameKey];
      if (!dest) return "That game isn't available in this build.";
      if (gameInSession) {
        return "You're in the middle of a match. Finish it first, then join.";
      }
      if (isTouch && !isPlayableOnMobile(dest)) {
        return "That game needs a keyboard — join from a computer.";
      }
      closeSidebar();
      setView(dest);
      return null;
    },
    [isTouch, gameInSession, closeSidebar]
  );

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

    // Set up custom event listener to toggle modern navigation menu from game
    // HUDs. The event may carry a detail:
    //   { panel: 'friends'|'messages'|'history'|'leaderboard'|'stats' }
    //     → open the drawer already on that panel (same SidebarOpenTarget
    //       mechanism the notification rows use), or
    //   { settings: true } → skip the drawer and open Profile Settings.
    // A bare event (Cells, Asteroids) still just opens the menu.
    const handleOpenMenu = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { panel?: "friends" | "messages" | "history" | "leaderboard" | "stats"; settings?: boolean }
        | undefined;
      if (detail?.settings) {
        setShowSettings(true);
        return;
      }
      if (detail?.panel) setSidebarTarget({ panel: detail.panel });
      setMenuOpen(true);
    };
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
    closeSidebar();
  }, [view, gameInSession, closeSidebar]);

  // MID-MATCH SUPPRESSION. `gameInSession` is the same flag that hides the nav
  // bar, so this is exactly "the player is playing": pop-ups are held back and
  // replayed the moment it goes false. Everything still lands in the bell
  // while it is true — quiet, not lost.
  React.useEffect(() => {
    setNotificationsInGame(gameInSession);
  }, [gameInSession, setNotificationsInGame]);

  // Fetch the backend account for the signed-in wallet and route into
  // AccountSetup when it's missing/unfinished. Returns the fresh status
  // so callers can branch without waiting for state.
  const refreshAccount = React.useCallback(async (): Promise<BackendAccount | null> => {
    try {
      const me = await profileApi.me();
      // Region follows the ACCOUNT across devices: adopt the stored choice
      // on any browser that hasn't picked one locally yet. (A local choice
      // always wins — the pickers write both.)
      if (me.region && !hasChosenRegion()) setRegion(me.region);
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

  // STAY SIGNED IN. On every load a stored session token is traded for a
  // fresh 30-day one, so a player who keeps visiting is never signed out
  // and never sees a signature prompt on a device they have already used.
  // Sessions used to last a day, which meant a wallet popup most mornings
  // — and every one of those was another chance to end up back on the
  // account screens.
  //
  // Only a FINISHED account is seeded into state here. An unfinished one
  // is deliberately left null so the follow-up effect below still runs and
  // routes that person into setup, exactly as it did before.
  React.useEffect(() => {
    let cancelled = false;
    refreshSession().then((acct) => {
      if (cancelled || !acct?.username || !acct.totpEnabled) return;
      setAccount({ username: acct.username, totpEnabled: acct.totpEnabled });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Follow-up rule: ANY signed-in session without a finished account
  // lands in Create Account — fresh logins via useLogin's onComplete
  // above, and restored/redirect sessions here. The panel drives the
  // wallet wait + signature exchange itself and self-dismisses when the
  // account turns out to be complete, so this never strands anyone.
  React.useEffect(() => {
    if (!authenticated) {
      // BEFORE THE AUTH CHUNK LANDS, `authenticated` IS FALSE FOR EVERYONE
      // — including someone with a perfectly live session. Treating that
      // window as "signed out" wiped the account the boot refresh had just
      // seeded, so the panel-free reload it exists to give was thrown away
      // a frame later. Wait for the SDK to actually report before believing
      // a sign-out; `showSignedIn` below hedges the same way for the nav.
      if (!authLoaded) return;
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
  }, [authLoaded, privyReady, authenticated, wallets, account, refreshAccount]);

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

  // Deferring the auth SDK means `authenticated` is false for the first
  // moment after load even for someone with a live session — which would
  // flash "Connect" in the nav at a signed-in user before flipping to
  // "Wallet" a second later. A stored session token is proof they WERE
  // signed in, so show the signed-in affordance from the first paint and let
  // the real value take over the instant it arrives. Read once: this is about
  // the initial render, and re-reading localStorage per render would let a
  // sign-out mid-session be masked by a stale token.
  /**
   * "We heard you, the sign-in is on its way."
   *
   * True only in the window between a first-time visitor pressing a sign-in
   * control and the wallet chunk arriving. It exists because that window used
   * to be invisible — the SDK was prefetched on idle, so a click was instant;
   * now the click is what pays for it.
   */
  const [signInPending, setSignInPending] = React.useState(false);

  const hadSession = React.useMemo(() => !!localStorage.getItem(AUTH_TOKEN_KEY), []);
  const showSignedIn = authenticated || (!authLoaded && hadSession);

  // IDLE PREFETCH. Code-splitting trades entry-chunk weight for a fetch at
  // navigation time, and the library is where essentially every visitor goes
  // next — so warm its chunk once the browser is idle. By the time anyone
  // clicks "Explore Games" the module is in the module map and the Suspense
  // fallback never appears; the landing page still paints without it.
  //
  // Only the library, deliberately. Prefetching the games too would pull
  // megabytes (Asteroids' engine, three.js, Stockfish) on a connection we
  // know nothing about, to win a spinner the GameChunkLoading screen already
  // covers gracefully.
  React.useEffect(() => {
    if (view !== "landing") return;
    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const warm = () => {
      void import("./components/ArcadeView");
      // The cursor FX mount on the first pointer move (usePointerAwake); a
      // cold visitor used to pay three.js fetch+parse AND two WebGL inits in
      // that single burst — a visible hitch right as they start interacting.
      // Warming the chunks here (idle time, after paint) leaves only the GL
      // init for the pointer-move moment.
      if (HEAVY_FX) {
        void import("./components/glass/CursorBlob3D");
        void import("./components/SplashCursor");
      }
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(warm, { timeout: 3000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(warm, 1500);
    return () => clearTimeout(id);
  }, [view]);

  /**
   * INVITE LINKS (?wager=<roomId>&g=<gameKey>&m=<mode>) — the shareable
   * private-wager URL, mobile + desktop. Parsed ONCE at boot into a ref
   * (then stripped from the address bar so a reload doesn't re-join), and
   * armed through the notifications store's JOIN handoff — the exact path a
   * friend invite takes, including the sign-in gate: an anonymous visitor
   * first runs requireAccount, and the join fires once hasAccount is true.
   */
  const wagerLinkRef = React.useRef<{ roomId: string; gameKey: string; mode: string } | null>(null);
  const wagerLinkNudged = React.useRef(false);
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get("wager");
    const gameKey = params.get("g");
    const mode = params.get("m");
    if (!roomId || !gameKey || !mode) return;
    if (!PRIVATE_WAGER_VIEWS[gameKey]) return; // unknown game — ignore
    wagerLinkRef.current = { roomId, gameKey, mode };
    params.delete("wager");
    params.delete("g");
    params.delete("m");
    const rest = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
  }, []);

  // The pending indicator's only job is to cover the chunk fetch, so it ends
  // the moment the SDK reports in — whatever it reports. From there Privy's
  // own modal (or the account screen) is the feedback.
  React.useEffect(() => {
    if (authLoaded && signInPending) setSignInPending(false);
  }, [authLoaded, signInPending]);

  // DEFERRED-AUTH REPLAY. Clicking a tile in the first moment after load —
  // before the auth chunk has landed — parks the destination in pendingDest
  // and asks for a login. A returning user with a finished account never sees
  // a modal (Privy restores their session and the bridge skips it), so
  // without this their click would just evaporate. Once the account is known
  // to be complete, honour where they were going.
  //
  // handleAccountComplete clears pendingDest synchronously on the setup path,
  // so this effect can't double-navigate behind it.
  React.useEffect(() => {
    if (!hasAccount) return;
    const dest = pendingDest.current;
    if (!dest || dest === "account_setup") return;
    pendingDest.current = null;
    setGameInSession(false);
    setView(dest);
  }, [hasAccount]);

  // THE GATE. Connect, Play Now and every game tile route through here:
  //   signed out            → Privy wallet popup (setup follows sign-in)
  //   signed in, no account → username + PIN + authenticator screen
  //   account complete      → straight to the destination
  const requireAccount = React.useCallback(
    (dest: View) => {
      setGameInSession(false);
      // DEVICE GATE, ahead of the auth gate. The library already hides
      // PC-only tiles on touch, but this is the funnel EVERY game entry runs
      // through — the sidebar, a private-wager invite for a keyboard game,
      // and the post-sign-in `pendingDest` replay all land here too. Blocking
      // once, here, means a phone cannot end up inside Asteroids by any route
      // rather than only by the route we remembered to cover.
      if (isTouch && !isPlayableOnMobile(dest)) {
        setView("arcade");
        return;
      }
      // A FINISHED ACCOUNT IS ENOUGH. Ask about the arcade session before
      // asking Privy anything.
      //
      // This is the order the gate always should have used. A player with a
      // valid session token, a registered username and a proven
      // authenticator IS signed in to Neon Arcade — that is what the whole
      // account system establishes. Privy is how they reach their WALLET,
      // which matters for money, not for opening a game.
      //
      // Asking Privy first meant a returning player whose SDK had not
      // finished reporting yet fell through to `login()`, and `login()`
      // does nothing for someone already authenticated (and merely queues
      // an intent when Privy is not ready). Either way the click
      // evaporated: no navigation, no modal, no error. Pressing PLAY NOW
      // simply did nothing — indefinitely, if Privy never settled.
      if (hasAccount) {
        setView(dest);
        return;
      }
      // Signed in to Privy but the account is unfinished — go and finish it,
      // whatever the other readiness flags say. Keep the FIRST interrupted
      // destination: a second gate hit while setup is already pending must
      // not overwrite where the user was originally headed.
      if (authenticated) {
        pendingDest.current = pendingDest.current ?? dest;
        setView("account_setup");
        return;
      }
      // Not signed in — OR the auth chunk is still in flight, which looks the
      // same from here. Either way: remember the destination and ask to log
      // in. `login()` is safe to call before the SDK is up; it queues the
      // intent and the bridge replays it once Privy reports ready, so an
      // early click is never silently swallowed.
      if (!authLoaded || !privyReady || !authenticated) {
        pendingDest.current = dest;
        // TELL THEM SOMETHING IS HAPPENING. The wallet SDK is no longer
        // downloaded on page load (see src/auth/index.tsx), so for a
        // first-time visitor this click is what fetches it — and on a slow
        // connection that is seconds during which `login()` changes nothing
        // any pixel reflects. Without this the primary call-to-action looks
        // broken and people tap it again. Cleared when the modal actually
        // opens (authLoaded flips) — see the effect below.
        if (!authLoaded) setSignInPending(true);
        login();
        return;
      }
      // (Unreachable: !hasAccount is implied and every authenticated state
      // returned above — kept as the type-narrowing fall-through only.)
      setView(dest);
    },
    [authLoaded, privyReady, authenticated, hasAccount, login, isTouch]
  );

  React.useEffect(() => {
    const link = wagerLinkRef.current;
    if (!link) return;
    if (!hasAccount) {
      // One nudge into the sign-in gate; requireAccount handles login AND
      // account setup, and this effect re-fires when hasAccount lands.
      if (!wagerLinkNudged.current && authLoaded) {
        wagerLinkNudged.current = true;
        requireAccount("arcade");
      }
      return;
    }
    wagerLinkRef.current = null;
    armJoin({
      roomId: link.roomId,
      gameKey: link.gameKey as PrivateGameKey,
      mode: link.mode,
      expiresAt: Date.now() + 10 * 60_000,
      fromUsername: "invite link",
    });
  }, [hasAccount, authLoaded, requireAccount, armJoin]);

  const handleVolumeChange = (vol: number) => {
    setMasterVolume(vol);
    localStorage.setItem("masterVolume", vol.toString());
    Howler.volume(vol);
  };

  // Play Now is a gated entry point: wallet popup first for signed-out
  // users, then username/PIN/authenticator, then the arcade. Mid-match the
  // exit guard owns the click: confirm → forfeit → results → progression →
  // only then this navigation runs.
  const handlePlayNow = () => {
    navigateWithExitGuard(() => requireAccount("arcade"));
  };

  const navigateToLanding = () => {
    navigateWithExitGuard(() => {
      setGameInSession(false);
      setView("landing");
    });
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

  /**
   * SIGN OUT — the Privy wallet and the arcade account, in one action.
   *
   * These were never really one action. Disconnecting dropped the backend
   * JWT and called Privy's logout, but left every trace of WHO was signed
   * in: `profile` and `account` in state, and the display profile in
   * localStorage. So the nav kept showing the previous player's name and
   * avatar, and a reload restored them — the account looked signed in
   * because, as far as the UI was concerned, it still was. On a shared
   * machine the next person inherited that identity.
   *
   * Now everything that identifies the account is torn down in one place,
   * in a deliberate order:
   *
   *   1. Revoke server-side FIRST, while the token still exists to
   *      authenticate with. That is what ends the session on other
   *      devices — a 30-day token cannot be un-issued afterwards.
   *   2. Tear down locally, unconditionally. A failed request must never
   *      leave somebody signed in on the machine in front of them.
   *   3. Log Privy out last, so a slow wallet SDK cannot delay any of it.
   *
   * Every step is failure-tolerant on purpose: sign-out is the one action
   * that has to work even when nothing else does.
   */
  /**
   * SIGN OUT, but never out from under a live match.
   *
   * The teardown below drops the game socket as its FIRST act, so this has
   * to be guarded around the whole operation rather than just the navigation
   * at the end: a forfeit needs that socket to tell the server the player
   * resigned. Mid-match this therefore confirms, forfeits, plays the results
   * and progression, and only then signs out — off a live match it runs
   * straight through, exactly as before.
   */
  const handleDisconnectWallet = async () => {
    navigateWithExitGuard(() => {
      void performDisconnect();
    });
  };

  const performDisconnect = async () => {
    // Close anything that renders account data.
    setShowWallet(false);
    setShowSettings(false);
    setMenuOpen(false);
    setSidebarTarget(null);

    // 1 + 2. Revoke, then forget. endSession() does both and never throws.
    disconnectGameSocket(); // drop the game socket so a stale-token session can't linger
    await endSession();

    // Everything we fetched AS that account. The QueryClient is a
    // module-level singleton, and `enabled: false` only stops refetching — it
    // never evicts. Without this, the nav-bar bell (which is rendered signed
    // out too) keeps rendering the previous account's friend requests and
    // unread DM previews from cache, on a shared machine, indefinitely.
    queryClient.clear();
    clearNotifications();

    // The display identity: state AND the copy that survives a reload.
    // Missing this last line is what made sign-out look broken.
    setAccount(null);
    setProfile(null);
    localStorage.removeItem(PROFILE_STORAGE_KEY);

    // Back to the signed-out world. Leaving the user inside the arcade (or
    // a game) after signing out is how they end up hitting gates that
    // re-prompt for a signature they did not ask for.
    pendingDest.current = null;
    autoFollowUpDone.current = false;
    setGameInSession(false);
    setView("landing");

    // 3. And the wallet session itself.
    try {
      await logout();
    } catch (err) {
      console.error("Privy sign-out failed:", err);
    }
  };

  const handleProfileUpdate = (newProfile: Profile) => {
    // The display name is locked to the registered unique username —
    // only the avatar is editable client-side.
    const next = { ...newProfile, name: account?.username ?? newProfile.name };
    setProfile(next);
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(next));
  };

  // Titles come from the catalog now — this was a second, hand-maintained
  // copy of the same nine strings.
  const viewToGameTitle: Record<string, string> = GAME_TITLES;

  return (
    /*
      h-[100dvh], not h-screen. `100vh` on mobile Safari/Chrome means the
      viewport with the URL bar HIDDEN, so with the bar showing — which is how
      the page first loads — the app is taller than the visible area and its
      bottom is cut off, while `overflow-hidden` here forbids scrolling to
      reach it. `100dvh` tracks the *dynamic* viewport and resizes as the bar
      retracts. (Two height classes can't be stacked as a fallback here: which
      one wins depends on stylesheet order, not attribute order. dvh is
      supported everywhere this app already runs.)
    */
    <div className="font-sans selection:bg-cyan-500/30 selection:text-cyan-200 h-[100dvh] overflow-hidden bg-[#081616] text-[#d7e5e5]">
      <LiquidFilter />
      <NeonViewportGlow />

      {/* SIGN-IN IS ON ITS WAY. Covers the one-off wallet-SDK download that a
          first-time visitor's first sign-in click now triggers (see
          signInPending). Deliberately a small corner toast rather than a
          blocking overlay: nothing is broken, the page stays usable, and if
          the chunk is already cached this never appears at all. */}
      {signInPending && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-full border border-[#00FFD1]/40 bg-[#04120f]/90 px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-[#00FFD1] shadow-[0_0_30px_rgba(0,255,209,0.25)] backdrop-blur-md"
        >
          <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-[#00FFD1] align-middle" />
          Opening sign-in…
        </div>
      )}
      {(view === "landing" ||
        view === "arcade" ||
        view === "neonconnect" ||
        view === "chess" ||
        view === "kickoff" ||
        view === "cells" ||
        view === "asteroids" ||
        view === "golf" ||
        view === "clumsy" ||
        view === "pugshooter" ||
        view === "volley") && (
        <React.Suspense fallback={null}>
          <SidebarMenu
            gameTitle={viewToGameTitle[view] || "Neon Arcade"}
            isOpen={menuOpen}
            onClose={closeSidebar}
            showDefaultTrigger={false}
            onOpenSettings={() => setShowSettings(true)}
            /* A notification row opens the drawer already on the right panel
               (and, for a message, already in the right conversation). */
            openTo={sidebarTarget}
          />
        </React.Suspense>
      )}

      {/*
        PRIVATE WAGER host + NOTIFICATIONS — exactly one instance each, app
        level, so they survive every view change (an invite must not be missed
        because you were on a different screen). Deliberately NOT inside
        SidebarMenu's conditional: an invite can land while you are mid-lobby.

        Gated on a finished account because every private:* / social:* event
        needs the authed socket, which only exists once a username + TOTP are
        set up. Unmounting the bridge on sign-out is also what clears the feed
        — see NotificationsSocketBridge.
      */}
      {hasAccount && (
        <React.Suspense fallback={null}>
          <NotificationsSocketBridge />
          {/* onOpenGame is what makes "accept from the nav bar" actually
              playable — it navigates to the game so its screen is mounted and
              listening before the match starts. */}
          <PrivateWagerHost onOpenGame={openGameForPrivateWager} />
          {/* Pop-ups sit at z-[150]: above the private-wager room (z-[110])
              and its countdown (z-[125]), below the sidebar drawer (z-[200])
              whose backdrop is meant to own the screen. */}
          <NotificationToasts
            onOpenMessages={(username) => openSidebarPanel("messages", username)}
            onOpenFriends={() => openSidebarPanel("friends")}
          />
        </React.Suspense>
      )}

      {/* Standalone Menu Button aligned vertically with the nav bar at top-6 */}
      {view !== "cells" && view !== "asteroids" && view !== "account_setup" && !gameInSession && (
        <button
          onClick={() => setMenuOpen(true)}
          /* ml/mt safe-area insets keep it clear of the notch in landscape;
             aria-label because `title` tooltips never appear on touch, so an
             icon-only control would otherwise be unlabelled there. */
          /* Mobile: the nav pill is ~56px tall from top-6, so top-[30px]
             centres this 45px circle on the pill's midline in its reserved
             left pocket; sm+ returns to the desktop corner position. */
          className="fixed top-[30px] left-4 sm:top-6 sm:left-6 z-[60] p-2.5 border border-[#00FFD1]/40 rounded-full backdrop-blur-md bg-[#081616]/60 hover:scale-105 active:scale-95 transition-all flex items-center justify-center cursor-pointer group select-none pointer-events-auto ml-[env(safe-area-inset-left)] mt-[env(safe-area-inset-top)]"
          title="Open Navigation Menu"
          aria-label="Open navigation menu"
        >
          <MenuIcon size={24} className="text-white group-hover:rotate-12 transition-transform duration-300" />
        </button>
      )}

      {/* ARCADE CURSOR (React Bits TargetCursor) — everywhere EXCEPT live
          gameplay: `gameInSession` is the games' own "a match is running"
          report (the same signal that blocks pop-ups), so the reticle shows
          on the landing page, the library, account setup AND every game
          LOBBY, then hands off to the game's own pointer the moment play
          starts. The selector covers the app's interactive vocabulary —
          buttons, links, and the clickable card divs — so it locks onto
          anything pressable without sprinkling .cursor-target around.
          Returns null on mobile by itself. */}
      {!gameInSession && (
        <TargetCursor
          targetSelector="button, a, [role='button'], .cursor-target, .magic-bento-card, .cursor-pointer"
          spinDuration={1.6}
          hideDefaultCursor={true}
          parallaxOn={true}
          hoverDuration={0.1}
          cursorColor="#00ffd1"
          hoverSoundSrc="/hoversoundfx.wav"
          clickSoundSrc="/clicksoundfx.wav"
        />
      )}

      {/* Fullscreen — during Chess/Connect GAMEPLAY it sits bottom-RIGHT
          like every other game's button. Menu screens keep it bottom-LEFT:
          the bottom-right corner there belongs to the library's settings
          cog (ArcadeView, z-50) and the notification toast stack (z-150),
          both of which would cover it. Same visibility rule as the nav
          (games and account setup hide it); same shared toggle as every
          game, and the global 'f' keybind still works. (VolleyLobby's own
          bottom-right copy was removed in the same pass — lobbies use this
          one button like every other menu screen.) */}
      {view !== "account_setup" &&
        (!gameInSession || view === "neonconnect" || view === "chess") && (
          <FullscreenButton
            positionClassName={
              gameInSession
                ? "fixed bottom-6 right-6 z-40"
                : "fixed bottom-6 left-6 z-40"
            }
          />
        )}

      {/* Floating Top Nav */}
      <AnimatePresence>
        {/* Hidden during account setup: every nav control (logo, library,
            wallet) navigates away from a flow that loses typed username/PIN
            and the TOTP secret on unmount. Same gate the floating hamburger
            and ActiveUsers strip already use. */}
        {view !== "account_setup" &&
          (!gameInSession || view === "neonconnect" || view === "chess") && (
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

              {/*
                pl-16 below lg: the floating hamburger is `fixed top-6 left-6`
                and the nav bar starts at x=16px, so with the old flat pl-4 the
                button sat directly on top of the logo at every width where the
                max-w-5xl pill reaches the left edge (~1160px and under). The
                extra left padding reserves that corner for it; from lg up the
                pill is inset far enough that it isn't needed.
              */}
              <div className="relative z-10 flex w-full items-center gap-1 sm:gap-2 md:gap-4 p-2 pl-16 lg:pl-6 border border-[#00FFD1]/40 rounded-full transition-all duration-500">
                {/* Logo. The wordmark is dropped on the narrowest screens —
                    the mark itself still identifies the app, and the ~90px it
                    frees is the difference between the nav fitting at 390px
                    and its controls being pushed off the pill. */}
                <div
                  className="flex items-center gap-2 mr-auto cursor-pointer min-w-0"
                  onClick={navigateToLanding}
                >
                  <img src="/NeonArcadeLogo.png" alt="Neon Arcade Logo" className="h-6 md:h-8 w-auto object-contain drop-shadow-[0_0_8px_rgba(0,255,209,0.5)] shrink-0" />
                  <span className="hidden xs:block text-white font-black italic tracking-tighter text-sm md:text-lg uppercase neon-text-glow whitespace-nowrap">
                    NEON ARCADE
                  </span>
                </div>

                {/*
                  Main Menu / Library. These used to be `hidden md:flex`, which
                  left phones with NO way to reach the library from the nav at
                  all. They are icon-only until lg (the labels were already
                  `hidden lg:inline`), so showing them costs ~72px and gives
                  mobile the same two destinations desktop has.
                */}
                <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
                  <button
                    onClick={navigateToLanding}
                    aria-label="Main Menu"
                    className={`flex items-center gap-2 px-2.5 sm:px-3 md:px-4 py-2 min-h-[44px] rounded-full transition-all text-xs md:text-sm font-medium ${
                      view === "landing"
                        ? "text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]"
                        : "text-white/60 hover:text-white"
                    }`}
                  >
                    <Compass className="w-4 h-4 shrink-0" />
                    <span className="hidden lg:inline">Main Menu</span>
                  </button>
                  <button
                    onClick={handlePlayNow}
                    aria-label="Library"
                    className={`flex items-center gap-2 px-2.5 sm:px-3 md:px-4 py-2 min-h-[44px] rounded-full transition-all text-xs md:text-sm font-medium ${
                      view === "arcade"
                        ? "text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]"
                        : "text-white/60 hover:text-white"
                    }`}
                  >
                    <Gamepad2 className="w-4 h-4 shrink-0" />
                    <span className="hidden lg:inline">Library</span>
                  </button>
                </div>

                {/* Profile Quick Access */}
                {profile && (
                  <div
                    onClick={() => setShowSettings(true)}
                    className="flex items-center gap-2 md:gap-3 pl-2 pr-1 sm:px-4 py-2 border-l border-white/10 cursor-pointer group hover:bg-white/5 transition-colors rounded-full shrink-0"
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

                {/*
                  NOTIFICATIONS. The bell used to be a daily-reward dropdown
                  and nothing else; it is now the arcade's whole inbox —
                  private-wager invites (with a JOIN that opens the waiting
                  room), friend requests, unread conversations, and the daily
                  reward as one row among them. Message and friend rows open
                  the matching sidebar panel through `openSidebarPanel`.
                */}
                <NotificationCenter
                  signedIn={hasAccount}
                  dailyAvailable={dailyAvailable}
                  onClaimDaily={handleClaimDaily}
                  balance={balance}
                  onOpenMessages={(username) => openSidebarPanel("messages", username)}
                  onOpenFriends={() => openSidebarPanel("friends")}
                />

                {/* Logged out → "Connect" opens the Privy login modal.
                    Logged in → "Wallet" opens the embedded-wallet panel
                    (address + SOL balance + export/disconnect). */}
                {showSignedIn ? (
                  <button
                    // Before the auth chunk lands `authenticated` is still
                    // false even for a signed-in user, so opening the panel
                    // would show nothing. Route through the gate instead —
                    // it queues the intent and resolves once Privy is up.
                    onClick={() => (authenticated ? setShowWallet(true) : requireAccount(view))}
                    /* This button also falls through to the sign-in gate while
                       the SDK is still absent (see the comment above), so it
                       warms the chunk on intent exactly like Connect does. */
                    onPointerEnter={prefetchAuth}
                    onFocus={prefetchAuth}
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
                    /* INTENT PREFETCH. A signed-out visitor never downloads
                       the 1.26 MB wallet SDK on load any more (see
                       src/auth/index.tsx), so start fetching it the moment
                       someone looks like they are about to sign in. Hover and
                       keyboard focus both count; by the time the click lands
                       the modal usually opens with no wait at all. */
                    onPointerEnter={prefetchAuth}
                    onFocus={prefetchAuth}
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
              {/* account_setup needs no clause here — the whole nav bar is
                  gated off during setup at the AnimatePresence above. */}
              {view !== "landing" && !gameInSession && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  /* hidden on phones: this second nav row sat ON TOP of the
                     library's filter strip (the content only pads for the
                     pill). The count still lives in the sidebar drawer. */
                  className="pointer-events-auto mt-2 z-40 hidden sm:block"
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
          <React.Suspense fallback={null}>
            <WalletPanel
              profile={profile}
              onClose={() => setShowWallet(false)}
              onDisconnect={handleDisconnectWallet}
            />
          </React.Suspense>
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
            {/* ESCAPE HATCH. The top nav is hidden during setup on purpose
                (its controls abandoned the flow mid-typing), which made this
                screen a dead end for anyone who decides not to finish — no
                cancel, no way back, and a reload re-enters setup. One small
                explicit exit restores the choice without re-adding the nav. */}
            <button
              type="button"
              onClick={navigateToLanding}
              className="fixed top-6 left-6 z-50 flex items-center gap-2 rounded-full border border-white/15 bg-black/40 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-white/60 backdrop-blur-md transition-all hover:border-[#00FFD1]/50 hover:text-[#00FFD1]"
            >
              ‹ Exit setup
            </button>
            <React.Suspense fallback={null}>
              <AccountSetup onComplete={handleAccountComplete} />
            </React.Suspense>
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
            <React.Suspense fallback={<GameChunkLoading label="Library" />}>
              <ArcadeView
                onSelectGame={requireAccount}
                masterVolume={masterVolume}
                onVolumeChange={handleVolumeChange}
                showVolumeConfig={showVolumeConfig}
                onToggleVolumeConfig={() => setShowVolumeConfig(!showVolumeConfig)}
              />
            </React.Suspense>
          </motion.div>
        ) : view === "neonconnect" ? (
          <motion.div
            key="neonconnect"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <React.Suspense fallback={<GameChunkLoading label="Neon Connect" />}>
              <NeonConnectGame
                onExit={() => {
                  setView("arcade");
                  setGameInSession(false);
                }}
                profile={profile}
                onGameStatusChange={setGameInSession}
              />
            </React.Suspense>
          </motion.div>
        ) : view === "chess" ? (
          <motion.div
            key="chess"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <React.Suspense fallback={<GameChunkLoading label="Neon Chess" />}>
              <ChessGame
                onExit={() => {
                  setView("arcade");
                  setGameInSession(false);
                }}
                profile={profile}
                onGameStatusChange={setGameInSession}
              />
            </React.Suspense>
          </motion.div>
        ) : view === "volley" ? (
          <motion.div
            key="volley"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <React.Suspense fallback={<GameChunkLoading label="Neon Volley" />}>
              <VolleyGame
                onExit={() => {
                  setView("arcade");
                  setGameInSession(false);
                }}
                profile={profile}
                onGameStatusChange={setGameInSession}
              />
            </React.Suspense>
          </motion.div>
        ) : view === "cells" ? (
          <motion.div
            key="cells"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <React.Suspense fallback={<GameChunkLoading label="Neon Cells" />}>
              {/* onGameStatusChange was the one game missing it, which meant
                  Cells was also the one game where a pop-up could land over a
                  live match. Every other game already reported its state. */}
              <CellsGame
                onExit={() => {
                  setView("arcade");
                  setGameInSession(false);
                }}
                profile={profile}
                onGameStatusChange={setGameInSession}
              />
            </React.Suspense>
          </motion.div>
        ) : view === "kickoff" ? (
          <motion.div
            key="kickoff"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <React.Suspense fallback={<GameChunkLoading label="Neon Kickoff" />}>
              <NeonKickoffGame
                onExit={() => {
                  setView("arcade");
                  setGameInSession(false);
                }}
                profile={profile}
                onGameStatusChange={setGameInSession}
              />
            </React.Suspense>
          </motion.div>

        ) : view === "golf" ? (
          <motion.div
            key="golf"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <React.Suspense fallback={<GameChunkLoading label="Neon Golf Clash" />}>
              <GolfGame
                onExit={() => {
                  setView("arcade");
                  setGameInSession(false);
                }}
                profile={profile}
                onGameStatusChange={setGameInSession}
              />
            </React.Suspense>
          </motion.div>
        ) : view === "clumsy" ? (
          <motion.div
            key="clumsy"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <React.Suspense fallback={<GameChunkLoading label="Neon Clumsy" />}>
              <ClumsyGame
                onExit={() => {
                  setView("arcade");
                  setGameInSession(false);
                }}
                profile={profile}
                onGameStatusChange={setGameInSession}
              />
            </React.Suspense>
          </motion.div>
        ) : view === "pugshooter" ? (
          <motion.div
            key="pugshooter"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <React.Suspense fallback={<GameChunkLoading label="Neon Pug Shooter" />}>
              <PugShooterGame
                onExit={() => {
                  setView("arcade");
                  setGameInSession(false);
                }}
                profile={profile}
                onGameStatusChange={setGameInSession}
              />
            </React.Suspense>
          </motion.div>
        ) : (
          <motion.div
            key="asteroids"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <React.Suspense fallback={<GameChunkLoading label="Neon Asteroids" />}>
              <AsteroidsGame
                onExit={() => {
                  setView("arcade");
                  setGameInSession(false);
                }}
                profile={profile}
                onGameStatusChange={setGameInSession}
              />
            </React.Suspense>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer (Shared) */}
      {view !== "asteroids" && view !== "cells" && view !== "volley" && view !== "chess" && view !== "golf" && view !== "clumsy" && view !== "pugshooter" && (
        <footer className="fixed bottom-0 left-0 right-0 z-50 hidden sm:flex justify-center gap-8 py-6 w-full bg-transparent font-mono text-[10px] tracking-[0.3em] text-[#00FFD1]/40 pointer-events-none">
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

/**
 * Should this device run the landing page's decorative WebGL?
 *
 * Both effects are cursor-driven — a three.js blob that chases the pointer
 * and a fluid simulation that splats where it moves — so on a touch device
 * they render a constant rAF loop and a ~256 kB gzip three.js download for
 * something the user can never actually interact with. `prefers-reduced-
 * motion` is honoured for the obvious reason, and a low core count stands in
 * for "this machine will not enjoy two WebGL contexts".
 *
 * Read once at module scope: the answer cannot change during a session, and
 * putting it in state would mean mounting the effects and then tearing them
 * down.
 */
const HEAVY_FX =
  typeof window !== "undefined" &&
  !!window.matchMedia &&
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
  !window.matchMedia("(pointer: coarse) and (hover: none)").matches &&
  (navigator.hardwareConcurrency ?? 8) > 4;

/**
 * True once the visitor has actually moved a pointer.
 *
 * HEAVY_FX answers "CAN this machine run the decorations". This answers
 * "does it MEAN anything yet", and the two are different questions. Both
 * effects follow the cursor, so before the first pointer movement they are
 * an invisible three.js download — 256 kB gzip, fetched during the cold load,
 * to render something nobody is interacting with. That download was the
 * second-largest item on the landing page.
 *
 * Waiting for one `pointermove` moves it off the critical path entirely
 * without taking the effect away from anyone who will actually see it: on a
 * desktop the pointer moves within a second or two of arriving, the chunk
 * arrives quietly after the page has loaded, and the blob fades in behind the
 * cursor as it always did. Someone who reads the page without touching the
 * mouse and clicks straight through never pays for it at all.
 *
 * `once: true` — the listener removes itself, and `passive` keeps it off the
 * scroll path.
 */
function usePointerAwake(enabled: boolean): boolean {
  const [awake, setAwake] = React.useState(false);

  React.useEffect(() => {
    if (!enabled || awake) return;
    const wake = () => setAwake(true);
    // Pointer events are the obvious trigger, but they are not the only one
    // that matters: CursorBlob3D also draws a retrowave sun that is centred
    // and fully visible before any cursor input. Waking on keyboard, focus
    // and scroll too means a keyboard-only or switch-access visitor still
    // gets the landing page's hero background instead of a flat gradient —
    // while the chunk stays off the cold-load critical path either way.
    const EVENTS = ["pointermove", "pointerdown", "keydown", "focusin", "scroll"] as const;
    for (const type of EVENTS) {
      window.addEventListener(type, wake, { once: true, passive: true });
    }
    return () => {
      for (const type of EVENTS) window.removeEventListener(type, wake);
    };
  }, [enabled, awake]);

  return awake;
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
  // Capability (HEAVY_FX) AND intent (a pointer that has moved) — see
  // usePointerAwake. Keeps three.js out of the cold-load waterfall.
  const showHeavyFx = usePointerAwake(HEAVY_FX);

  return (
    <>
      {/* Background. The gradient + GlassPanel below carry the look on their
          own; the two WebGL layers are an enhancement for pointer devices
          that can afford them (see HEAVY_FX). */}
      <div className="fixed inset-0 z-0 bg-[#081616]">
        {/* Ambient mint starfield (React Bits Particles, ogl) — the base
            background layer; the cursor FX float above it. Continuous by
            design (a frozen starfield reads as dead); 700 GL points are
            cheap and rAF pauses in hidden tabs. */}
        <div className="absolute inset-0" style={{ zIndex: 0 }}>
          <Particles
            particleColors={["#00ffd1"]}
            particleCount={700}
            particleSpread={10}
            speed={0.1}
            particleBaseSize={100}
            moveParticlesOnHover={true}
            alphaParticles={false}
            disableRotation={false}
          />
        </div>
        {showHeavyFx && (
          <>
            <SafeErrorBoundary>
              <React.Suspense fallback={null}>
                <CursorBlob3D />
              </React.Suspense>
            </SafeErrorBoundary>
            <CursorGlow />
            <SafeErrorBoundary>
              <React.Suspense fallback={null}>
                {/* Spec defaults (splash cursor - default settings.txt):
                    every tuning prop at its stock value — the only overrides
                    are the static mint colour (no rainbow cycling) and the
                    layout props this layer needs. */}
                <SplashCursor
                  COLOR="#00ffd1"
                  RAINBOW_MODE={false}
                  zIndex={1}
                  position="absolute"
                />
              </React.Suspense>
            </SafeErrorBoundary>
          </>
        )}
        {/* PLAIN gradient scrim — deliberately NOT a GlassPanel. The panel's
            full-viewport backdrop-filter (blur+saturate+contrast) sat directly
            on top of BOTH WebGL canvases, so every fluid/blob frame was billed
            an additional full-screen blur readback — measured at ~39fps on an
            M-series laptop. The canvases are already soft (bloom, fluid dye);
            the scrim keeps the darkening without the per-frame tax. */}
        <div
          className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/80"
          style={{ zIndex: 2 }}
        />
      </div>

      {/*
        SCROLLABLE, and justified from the top on phones. The app root is
        `overflow-hidden` (it has to be — games own their own viewport), so if
        this pane doesn't scroll, nothing does: the headline, both CTAs and
        the stats bar are together taller than a 390x844 screen, and the
        bottom of the page was simply unreachable. `justify-center` is kept
        from md up, where the content does fit and centring is the right look.
      */}
      <main className="relative z-10 h-full overflow-y-auto overflow-x-hidden flex flex-col items-center justify-start md:justify-center text-center px-6 pt-24 pb-20">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 1, delay: 0.2 }}
          className="max-w-5xl w-full"
        >
          {/* HERO — React Bits ParticleText, one instance per line so the
              stacked SKILL-BASED / BETTING layout survives (the component
              samples a single line of text). Sizes mirror the old TrueFocus
              h1 exactly: text-5xl/7xl/9xl line boxes. fontWeight carries the
              italic through the canvas font shorthand ("italic 900 96px …").
              trigger="click" = clicking the headline replays the scatter. */}
          <h1 className="mb-6 select-none" aria-label="SKILL-BASED BETTING">
            <div className="h-[3.5rem] sm:h-[5.5rem] md:h-[9.5rem]">
              <ParticleText
                text="SKILL-BASED"
                particleSize={1.9}
                density={4}
                color="#a9d4ff"
                highlightColor="#00ffd1"
                scatter={160}
                gatherDuration={1600}
                stagger={420}
                pointerRepel={40}
                repelRadius={120}
                idleDrift={0}
                trigger="click"
                fontSize="clamp(3rem, 12vw, 8rem)"
                fontWeight="italic 900"
                fontFamily="inherit"
                glow
              />
            </div>
            {/* Dark halo on this line only: BETTING sits directly over the
                bright retrowave sun, and mint particles vanished against it —
                the old TrueFocus survived the same spot with a black text
                stroke. drop-shadow filters the canvas layer, so every
                particle carries its own dark edge. */}
            <div className="h-[3.5rem] sm:h-[5.5rem] md:h-[9.5rem] [filter:drop-shadow(0_2px_2px_rgba(0,0,0,0.9))_drop-shadow(0_0_12px_rgba(0,0,0,0.7))]">
              <ParticleText
                text="BETTING"
                particleSize={1.9}
                density={4}
                color="#a9d4ff"
                highlightColor="#00ffd1"
                scatter={160}
                gatherDuration={1600}
                stagger={420}
                pointerRepel={40}
                repelRadius={120}
                idleDrift={0}
                trigger="click"
                fontSize="clamp(3rem, 12vw, 8rem)"
                fontWeight="italic 900"
                fontFamily="inherit"
                glow
              />
            </div>
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
              /* Play Now runs the same sign-in gate as Connect, so warm the
                 wallet chunk on intent here too — see prefetchAuth. */
              onPointerEnter={prefetchAuth}
              onFocus={prefetchAuth}
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
              <Stat value={<PlayerEarningsValue />} label="Player Earnings" />
              <div className="hidden sm:block w-px h-10 bg-[#00FFD1]/40"></div>
              <Stat value="6" label="Exclusive Titles" />
            </div>
          </div>
        </motion.div>
      </main>
    </>
  );
}

/**
 * Career payout total behind the landing page's PLAYER EARNINGS stat, in SOL.
 *
 * Still a placeholder zero — there is no server-side earnings ledger to read
 * from yet — but it is now a SOL *quantity* rather than a hard-coded glyph,
 * so the moment a real total exists this stat renders it in whatever currency
 * the player picked, with no further change here.
 */
const PLAYER_EARNINGS_SOL = 0;

/**
 * The earnings number, denominated in the player's chosen display currency.
 *
 * Picking SOL keeps the original treatment exactly — the Solana mark beside a
 * bare number. Any fiat choice renders a single formatted string (`A$0`,
 * `₦0`, `¥0`), compact so a seven-figure total can't blow out the stat bar.
 */
function PlayerEarningsValue() {
  const { formatSolAs, isNative } = useCurrency();
  const text = formatSolAs(PLAYER_EARNINGS_SOL, { compact: true, bare: isNative });

  if (isNative) {
    return (
      <div className="flex items-center gap-1.5 -translate-x-0.5">
        <img src="/solana-sol-icon.svg" alt="SOL" className="h-5 md:h-6 w-auto" />
        <span className="tabular-nums">{text}</span>
      </div>
    );
  }

  return <span className="tabular-nums">{text}</span>;
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
