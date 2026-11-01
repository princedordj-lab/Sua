import { useEffect, useRef, useState } from "react";

/**
 * Clerk reports authentication in three shapes: `isLoaded === false` while it
 * resolves, `isSignedIn === undefined` while it resolves, and
 * `isSignedIn === false` only once it has a verdict. The Expo SDK additionally
 * syncs a native Clerk client into the JS client at runtime (and polls Clerk
 * every five minutes), so a signed-in student can read as signed out for a
 * frame. `@clerk/expo` 4.14.2 documents exactly that: the SDK "no longer
 * briefly reports the user as signed out while it recovers".
 *
 * Routing must never turn one of those frames into a logout, so every guard
 * reads a verdict that has to be *stable* before it counts:
 *
 * - `signed-in` is believed immediately (a session is positive evidence);
 * - `signed-out` only once the reading has held for the grace period;
 * - `loading` until one of the two is established. `isLoaded === false` is
 *   never a verdict on its own.
 */
export type AuthVerdict = "loading" | "signed-in" | "signed-out";

/** How long a "signed out" reading must hold before it is believed. */
export const SIGNED_OUT_GRACE_MS = 1_500;

export function useAuthVerdict(
  isLoaded: boolean,
  isSignedIn: boolean | undefined,
  graceMs: number = SIGNED_OUT_GRACE_MS,
): AuthVerdict {
  // Set only by the timer below, i.e. after a signed-out reading survived the
  // grace period. A raw "signed in" clears it again so the next sign-out has to
  // earn the verdict too: believing a stale confirmation would turn one
  // transient frame after a re-login into a logout.
  const [signedOutConfirmed, setSignedOutConfirmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while a signed-out reading is already being timed, so re-renders (and
  // Clerk's own state churn) cannot restart the clock forever.
  const waitingOnSignedOut = useRef(false);

  useEffect(() => {
    const clear = () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };

    // A session, or Clerk still resolving, ends any pending window.
    if (isSignedIn === true || !isLoaded) {
      clear();
      waitingOnSignedOut.current = false;
      // Re-arm the grace period. Without this, a process that signed out once
      // would believe every later signed-out frame immediately (token refresh,
      // native client sync) — exactly the flicker this hook prevents.
      //
      // Deferred because a synchronous state update from an effect body causes
      // a cascading render, and this is not time-critical: the render below
      // already reports "signed-in"/"loading", so the stale confirmation cannot
      // be read before the microtask lands. React bails out when it is false.
      queueMicrotask(() => setSignedOutConfirmed(false));
      return;
    }

    if (waitingOnSignedOut.current) return;
    waitingOnSignedOut.current = true;
    timer.current = setTimeout(() => {
      timer.current = null;
      setSignedOutConfirmed(true);
    }, graceMs);
  }, [graceMs, isLoaded, isSignedIn]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Positive evidence wins on the spot.
  if (isSignedIn === true) return "signed-in";
  // Clerk is updating its own state (token refresh, native client sync); that
  // says nothing about the session.
  if (!isLoaded) return "loading";
  return signedOutConfirmed ? "signed-out" : "loading";
}
