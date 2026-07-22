import { useMemo, useEffect, useRef, useState } from "react";

interface ActiveUsersProps {
  realCount: number;
  label?: string;
  throttleMs?: number; // how often the display can update, default 5000ms
}

// Inflation formula: x2 below 1000, +1000 at 1000+
function getDisplayCount(real: number): number {
  return real <= 1000 ? real * 2 : real + 1000;
}

// 1. STRICT VALIDATION — rejects floats, negatives, NaN, Infinity
function sanitiseCount(value: unknown): number | null {
  if (!Number.isInteger(value)) return null;
  if ((value as number) < 0) return null;
  return value as number;
}

// 2. THROTTLE HOOK — limits how often the displayed value can change
function useThrottledValue<T>(value: T, delayMs: number): T {
  const [throttled, setThrottled] = useState<T>(value);
  const lastUpdated = useRef<number>(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // If the value drops to 0, update immediately (e.g., disconnected state)
    if (value === 0) {
      if (pending.current) clearTimeout(pending.current);
      lastUpdated.current = Date.now();
      setThrottled(value);
      return;
    }

    const now = Date.now();
    const remaining = delayMs - (now - lastUpdated.current);

    if (remaining <= 0) {
      lastUpdated.current = now;
      setThrottled(value);
    } else {
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        lastUpdated.current = Date.now();
        setThrottled(value);
      }, remaining);
    }

    return () => {
      if (pending.current) clearTimeout(pending.current);
    };
  }, [value, delayMs]);

  return throttled;
}

export default function ActiveUsers({
  realCount,
  label = "players online",
  throttleMs = 5000,
  variant = "default",
}: ActiveUsersProps & { variant?: "default" | "mini" }) {
  // 2. THROTTLE — display only updates at most once per throttleMs
  const throttledCount = useThrottledValue(realCount, throttleMs);

  // 1. VALIDATE — reject anything that isn't a clean non-negative integer
  const displayCount = useMemo(() => {
    const safe = sanitiseCount(throttledCount);
    if (safe === null) return null;
    return getDisplayCount(safe);
  }, [throttledCount]);

  if (displayCount === null) return null; // invalid input, render nothing

  if (variant === "mini") {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1 bg-[#081616]/80 border border-[#00FFD1]/30 rounded-full shadow-[0_0_10px_rgba(0,255,209,0.15)] backdrop-blur-md">
        <span 
          className="w-1.5 h-1.5 rounded-full bg-[#00FFD1] shadow-[0_0_6px_#00FFD1] animate-pulse" 
          aria-hidden="true" 
        />
        <span className="text-[#00FFD1] text-[10px] font-mono font-bold tracking-widest uppercase">
          {displayCount.toLocaleString()} {label}
        </span>
      </div>
    );
  }

  return (
    <div className="text-center flex flex-col items-center">
      <div className="text-[#00FFD1] text-2xl md:text-3xl font-bold tracking-tighter flex items-center justify-center gap-2">
        <span 
          className="w-2.5 h-2.5 rounded-full bg-[#00FFD1] shadow-[0_0_8px_#00FFD1] animate-pulse" 
          aria-hidden="true" 
        />
        {displayCount.toLocaleString()}
      </div>
      <div className="text-[8px] md:text-[10px] uppercase tracking-[0.2em] text-[#83958D] mt-1">
        {label}
      </div>
    </div>
  );
}
