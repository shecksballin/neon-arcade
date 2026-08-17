/**
 * ERROR SCREEN
 * ============
 * Full-screen neon error page keyed by HTTP status code — replaces the
 * blank white screen when something breaks. Each code gets its own
 * arcade-flavored title, flavor line, and icon; unknown codes fall back
 * by range (4xx / 5xx). Status 0 means the request never reached the
 * server (offline, CORS, server restarting). No status at all means a
 * client-side render crash (see AppErrorBoundary).
 *
 * Usage with React Query:
 *   if (isError) return <ErrorScreenFromError error={error} onRetry={refetch} />
 */
import { motion } from "motion/react";
import {
  AlertTriangle,
  Ban,
  Bug,
  CloudOff,
  Compass,
  Gauge,
  Hourglass,
  Lock,
  ServerCrash,
  Swords,
  TimerOff,
  WifiOff,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { ApiError, NETWORK_ERROR_MESSAGE } from "../lib/api";

interface StatusContent {
  icon: LucideIcon;
  title: string;
  flavor: string;
}

const STATUS_CONTENT: Record<number, StatusContent> = {
  0: {
    icon: WifiOff,
    title: "Signal Lost",
    flavor: "The arcade can't reach the server. Check your connection — we'll get you back in the game.",
  },
  400: {
    icon: AlertTriangle,
    title: "Glitched Input",
    flavor: "That request came through scrambled. Head back and try again.",
  },
  401: {
    icon: Lock,
    title: "Insert Coin",
    flavor: "Your session expired. Sign in again to keep playing.",
  },
  403: {
    icon: Ban,
    title: "VIP Room",
    flavor: "You don't have access to this corner of the arcade.",
  },
  404: {
    icon: Compass,
    title: "Lost in the Grid",
    flavor: "This screen doesn't exist — the pixels you're looking for have moved.",
  },
  408: {
    icon: TimerOff,
    title: "Timed Out",
    flavor: "The server took too long to answer. Give it another shot.",
  },
  409: {
    icon: Swords,
    title: "Button Mash",
    flavor: "Two moves collided mid-flight. Refresh and try again.",
  },
  429: {
    icon: Gauge,
    title: "Slow Down, Speedrunner",
    flavor: "Too many requests too fast. Take a breath and retry.",
  },
  500: {
    icon: ServerCrash,
    title: "System Malfunction",
    flavor: "Something shorted out on our side. It's not you — try again in a moment.",
  },
  502: {
    icon: CloudOff,
    title: "Bad Gateway",
    flavor: "The arcade's upstream link dropped a packet. Retry in a moment.",
  },
  503: {
    icon: Wrench,
    title: "Under Maintenance",
    flavor: "This cabinet is down for service. Back online soon.",
  },
  504: {
    icon: Hourglass,
    title: "Gateway Timeout",
    flavor: "The upstream took too long to respond. Try again shortly.",
  },
};

// Client-side render crash — not an HTTP failure, so no numeric code.
const CRASH_CONTENT: StatusContent = {
  icon: Bug,
  title: "Fatal Glitch",
  flavor: "The screen hit a bug it couldn't recover from. A restart usually fixes it.",
};

function contentFor(status: number | undefined): StatusContent {
  if (status === undefined) return CRASH_CONTENT;
  const exact = STATUS_CONTENT[status];
  if (exact) return exact;
  if (status >= 500) return STATUS_CONTENT[500];
  if (status >= 400) return STATUS_CONTENT[400];
  return CRASH_CONTENT;
}

export interface ErrorScreenProps {
  /** HTTP status of the failure; 0 = never reached the server; omit for a render crash. */
  status?: number;
  /** Override the per-status headline. */
  title?: string;
  /** Server-provided detail, shown under the flavor line when it adds anything. */
  message?: string;
  onRetry?: () => void;
  onHome?: () => void;
  /** true (default) = fixed overlay covering the viewport; false = fills its parent. */
  fullScreen?: boolean;
}

export function ErrorScreen({
  status,
  title,
  message,
  onRetry,
  onHome,
  fullScreen = true,
}: ErrorScreenProps) {
  const content = contentFor(status);
  const Icon = content.icon;
  const bigCode = status === undefined ? "×_×" : status === 0 ? "OFF" : String(status);
  const errTag =
    status === undefined
      ? "ERR_RENDER_CRASH"
      : status === 0
        ? "ERR_CONNECTION_LOST"
        : `ERR_HTTP_${status}`;
  // Skip the raw detail when it just repeats what the flavor already says.
  const detail = message && message !== NETWORK_ERROR_MESSAGE ? message : null;
  // Never leave the player at a dead end — with no handlers, offer a reload.
  const showReload = !onRetry && !onHome;

  return (
    <div
      className={`${
        fullScreen ? "fixed inset-0 z-[9990]" : "relative w-full h-full min-h-[420px]"
      } bg-[#081616] flex items-center justify-center overflow-hidden error-flicker`}
    >
      {/* CRT scanlines + a soft center vignette */}
      <div className="error-scanlines" />
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,rgba(0,255,209,0.07)_0%,transparent_60%)]" />

      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="relative z-10 flex flex-col items-center text-center px-6 max-w-2xl"
      >
        <Icon className="w-10 h-10 mb-6 text-[#00FFD1] neon-glow-primary" strokeWidth={1.5} />

        <div className="error-code text-8xl sm:text-9xl font-black italic tracking-tighter text-white leading-none select-none">
          {bigCode}
        </div>

        <h1 className="mt-6 text-xl sm:text-2xl font-black uppercase tracking-[0.25em] text-[#00FFD1] neon-text-glow">
          {title ?? content.title}
        </h1>

        <p className="mt-4 text-sm sm:text-base text-[#83958d] max-w-md">{content.flavor}</p>

        {detail && (
          <p className="mt-4 px-4 py-2 rounded-lg border border-[#00FFD1]/20 bg-[#00FFD1]/5 font-mono text-xs text-[#d7e5e5]/70 max-w-md break-words">
            {detail}
          </p>
        )}

        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          {onRetry && (
            <button onClick={onRetry} className="btn-primary rounded-full px-8 py-3 uppercase">
              Try Again
            </button>
          )}
          {onHome && (
            <button onClick={onHome} className="btn-ghost rounded-full px-8 py-3 uppercase">
              Back to Arcade
            </button>
          )}
          {showReload && (
            <button
              onClick={() => window.location.reload()}
              className="btn-primary rounded-full px-8 py-3 uppercase"
            >
              Restart
            </button>
          )}
        </div>

        <div className="mt-10 font-mono text-[10px] tracking-[0.3em] text-[#00FFD1]/40 uppercase">
          {errTag} — insert coin to continue
        </div>
      </motion.div>
    </div>
  );
}

/**
 * Convenience wrapper: hand it whatever was thrown (React Query's `error`,
 * a caught exception) and it maps ApiError.status → the right screen.
 */
export function ErrorScreenFromError({
  error,
  ...rest
}: { error: unknown } & Omit<ErrorScreenProps, "status" | "message">) {
  let status: number | undefined;
  let message: string | undefined;

  if (error instanceof ApiError) {
    status = error.status;
    message = error.message;
  } else if (error instanceof Error) {
    // Legacy plain-Error network failures still carry the exact message.
    status = error.message === NETWORK_ERROR_MESSAGE ? 0 : 500;
    message = error.message;
  } else {
    status = 500;
  }

  return <ErrorScreen status={status} message={message} {...rest} />;
}
