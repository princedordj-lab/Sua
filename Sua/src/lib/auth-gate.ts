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
  // grace period. It is never cleared: a raw "signed in" outranks it during
  // render, and a later sign-out is a real sign-out, so believing it at once
  // costs nothing. A false positive can only be a transient frame, in which
  // case the next render reads "signed-in" again and the screens that landed
  // on Welcome route themselves back.
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
