/**
 * DEVICE / VIEWPORT DETECTION
 * ===========================
 * Two questions that look like one and are not:
 *
 *   isTouch   "can this person play a keyboard-and-mouse game?"  → CAPABILITY
 *   isNarrow  "will this layout fit?"                            → SIZE
 *
 * Keeping them apart matters. If the game allow-list keyed off width, then
 * dragging a desktop window narrow would make Asteroids vanish from the
 * library, which is wrong — a small window still has a keyboard. And if the
 * layout keyed off touch capability, an iPad in landscape would get the
 * phone layout it does not need. So the library hides PC-only titles on
 * `isTouch`, and the CSS/layout switches on `isNarrow`.
 *
 * `isMobile` is the union — "phone-like", i.e. a touch device that is also
 * small — and is what the shell uses when it needs one answer.
 *
 * WHY `(pointer: coarse) and (hover: none)` AND NOT A UA SNIFF
 * -----------------------------------------------------------
 * Together these two mean "the primary input is a finger and there is no
 * hover state" — true on phones and tablets, false on desktops, and false on
 * touchscreen laptops (which report `hover: hover` because they also have a
 * trackpad). That last case is exactly the one a UA string gets wrong, and
 * it is the one that matters: a Surface owner should still get Asteroids.
 *
 * TESTING OVERRIDE
 * ----------------
 * `?mobile=1` forces mobile on, `?mobile=0` forces it off, and the choice
 * sticks in localStorage so it survives the reloads you do while checking a
 * layout. Clear it with `?mobile=auto`. Without this the mobile library is
 * only reachable from an actual phone or devtools emulation, which does not
 * emulate `hover: none` reliably across browsers.
 */

import { useEffect, useState } from "react";

/** Below this, the shell switches to its stacked/compact layout. */
const NARROW_MAX_PX = 767;

const TOUCH_QUERY = "(pointer: coarse) and (hover: none)";
const NARROW_QUERY = `(max-width: ${NARROW_MAX_PX}px)`;

const OVERRIDE_KEY = "neon_force_mobile";

/**
 * Reads the ?mobile= override, persisting any new value. Returns null when no
 * override is in play, in which case the media queries decide.
 */
function readOverride(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const param = new URLSearchParams(window.location.search).get("mobile");
    if (param === "auto") {
      localStorage.removeItem(OVERRIDE_KEY);
      return null;
    }
    if (param === "1" || param === "0") {
      localStorage.setItem(OVERRIDE_KEY, param);
      return param === "1";
    }
    const saved = localStorage.getItem(OVERRIDE_KEY);
    if (saved === "1" || saved === "0") return saved === "1";
  } catch {
    // Private-mode Safari throws on localStorage — fall through to the
    // media queries, which always work.
  }
  return null;
}

export interface DeviceInfo {
  /** Finger-driven device with no hover. Gates the PC-only game list. */
  isTouch: boolean;
  /** Viewport narrower than the shell's desktop layout needs. */
  isNarrow: boolean;
  /** Phone-like: touch AND narrow. What most callers want. */
  isMobile: boolean;
}

/**
 * Computed synchronously on first render (not in an effect) so the library
 * never paints the full nine-tile desktop grid and then snaps down to three
 * on a phone.
 */
function readDevice(): DeviceInfo {
  if (typeof window === "undefined" || !window.matchMedia) {
    return { isTouch: false, isNarrow: false, isMobile: false };
  }
  const override = readOverride();
  const isTouch = override ?? window.matchMedia(TOUCH_QUERY).matches;
  const isNarrow = override ?? window.matchMedia(NARROW_QUERY).matches;
  return { isTouch, isNarrow, isMobile: isTouch && isNarrow };
}

export function useDevice(): DeviceInfo {
  const [device, setDevice] = useState<DeviceInfo>(readDevice);

  useEffect(() => {
    if (!window.matchMedia) return;
    // Both queries feed one state object, so a rotation that changes only
    // `isNarrow` still produces a single re-render rather than two.
    const touchMq = window.matchMedia(TOUCH_QUERY);
    const narrowMq = window.matchMedia(NARROW_QUERY);
    const sync = () =>
      setDevice((prev) => {
        // readDevice() returns a fresh object every call; without this bail
        // every raw resize event (dozens/second while dragging a window
        // edge, or a mobile URL-bar collapse) re-rendered the ENTIRE app.
        const next = readDevice();
        return prev.isTouch === next.isTouch && prev.isNarrow === next.isNarrow
          ? prev
          : next;
      });

    touchMq.addEventListener("change", sync);
    narrowMq.addEventListener("change", sync);
    // Orientation changes can land before the media query settles on some
    // mobile browsers; a resize pass catches those.
    window.addEventListener("resize", sync);
    return () => {
      touchMq.removeEventListener("change", sync);
      narrowMq.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);

  return device;
}

/** Convenience for the many call sites that only care about "phone-like". */
export function useIsMobile(): boolean {
  return useDevice().isMobile;
}
