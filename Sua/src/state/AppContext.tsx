import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth, useClerk, useUser } from "@clerk/expo";
import NetInfo from "@react-native-community/netinfo";
import { useAuthVerdict, type AuthVerdict } from "../lib/auth-gate";
import { AppState, Platform } from "react-native";
import { API_BASE_URL, coursesApi, profileApi, pushApi } from "../lib/api";
import { useSQLiteContext } from "expo-sqlite";
import {
  advanceNotesPullCursor,
  clearStudyDataForAccountSwitch,
  getSetting,
  listNotes,
  listLocalCourses,
  pullCourseNotes,
  pullTombstones,
  purgeCourseLocally,
  readNotesPullCursor,
  removeLocalCourse,
  replaceLocalCourses,
  saveNote,
  setSetting,
  syncPendingNotes,
  upsertLocalCourse,
  type LocalCourse,
} from "../lib/notes";
import { writeOnboardedCache } from "../lib/onboarding-cache";
import { flushUploads } from "../lib/uploads";
import { drainGenerationQueue, reconcileAiOutputs } from "../lib/generate";
import { flushStudyProgress } from "../lib/progress";
import { addPushTokenRefreshListener, registerForPushAndReport } from "../lib/notifications";
import {
  EMPTY_APP_STREAK,
  localDayKey,
  optimisticStreak,
  readCachedStreak,
  readPendingDays,
  recordAppOpen,
  syncAppStreak,
  type AppStreak,
} from "../lib/streak";
import type {
  Course,
  ServerCourse,
  ServerProfile,
  UserProfile,
} from "../lib/types";

type AppContextValue = {
  isLoaded: boolean;
  // Debounced verdict, safe for routing: it only reports "signed out" after the
  // reading was stable (see lib/auth-gate.ts).
  authVerdict: AuthVerdict;
  isSignedIn: boolean;
  isSignedOut: boolean;
  // True from the moment signOut() starts until a session exists again. Routing
  // uses it so the welcome screen's self-heal does not fight an explicit
  // sign-out during the grace window.
  isSigningOut: boolean;
  // True from the moment an auth flow reports a completed sign-in until the
  // debounced verdict confirms it (or a bounded timer runs out). auth-finish
  // holds instead of treating a stale "signed-out" verdict as a logout while
  // Clerk syncs the freshly created session.
  isAuthClaimPending: boolean;
  // Called by the sign-in screens the moment a flow resolves a session.
  markAuthClaim: () => void;
  isHydrating: boolean;
  hydrationIssue: boolean;
  hydrationError: string | null;
  // True when the API answered 401 for this session: the token exists but the
  // server will not accept it (almost always an app/API Clerk instance
  // mismatch). Distinct from "offline" so the UI stops telling students to
  // check their connection.
  authRejected: boolean;
  // True when the API answered 503: it is reachable and deliberately busy
  // (its database is saturated), which is a different student problem from
  // "no network" and a different one again from a rejected session.
  serverBusy: boolean;
  // True once a server profile was hydrated. Routing must not treat an
  // unresolved profile as "not onboarded".
  isProfileResolved: boolean;
  hasCompletedOnboarding: boolean;
  profile: UserProfile | null;
  courses: Course[];
  // Server-synced daily app-open streak (same number on mobile and web).
  appStreak: AppStreak;
  refreshAppStreak: () => Promise<void>;
  getAuthToken: () => Promise<string | null>;
  retryHydration: () => void;
  // Push queued note changes (deletes included) now instead of waiting for the
  // next reconnect/foreground event.
  flushNoteQueue: () => Promise<void>;
  signOut: () => Promise<void>;
  updateProfile: (changes: Partial<UserProfile>) => Promise<void>;
  deleteAccount: () => Promise<void>;
  completeOnboarding: (
    profile: UserProfile,
    firstCourse: Omit<Course, "id">,
  ) => Promise<void>;
  addCourse: (course: Omit<Course, "id">) => Promise<void>;
  updateCourse: (id: string, changes: Partial<Course>) => Promise<void>;
  deleteCourse: (id: string, moveNotesToCourseId?: string) => Promise<void>;
};

const AppContext = createContext<AppContextValue | null>(null);

type HydratedState = {
  clerkId: string;
  profile: ServerProfile | null;
  courses: Course[];
};

const EMPTY_HYDRATED: HydratedState = {
  clerkId: "",
  profile: null,
  courses: [],
};

// A bootstrap attempt, tagged with the account it was started for and whether a
// newer refresh arrived while it was running.
type HydrationAttempt = {
  userId: string;
  refreshWanted: boolean;
};

// Clerk's getToken retries internally when the network is bad and can hang
// well past every UI fallback; racing it keeps a stuck call bounded. A race
// loss reads as a token miss and feeds the bounded retry path below.
const TOKEN_TIMEOUT_MS = 10_000;
// The /me bootstrap verdict must land inside the auth-finish fallback window,
// so it gets a tighter ceiling than the default 30s request timeout.
const BOOTSTRAP_TIMEOUT_MS = 15_000;
// Upper bound on how long auth-finish will tolerate a stale "signed out"
// verdict right after a completed sign-in. Only a real failure pays this
// wait: the debounce itself confirms a healthy session long before it.
const AUTH_CLAIM_MAX_MS = 20_000;
// A failed hydration pass is retried on a bounded, jittered ladder instead of a
// flat 15s, and the ladder resets the moment an attempt lands. An API that is
// rejecting us — or starving on its own connection pool — must not be re-burst
// every 15 seconds for as long as the app is open.
const HYDRATION_RETRY_DELAYS_MS = [15_000, 30_000, 60_000];
// Each course pull holds one pooled database connection for its whole
// transaction, and the API instance only owns a handful. An unbounded
// `Promise.all` over every course is how one burst outran that pool.
const COURSE_PULL_CONCURRENCY = 3;

// A 5xx (including the API's retryable 503 for a saturated database) means the
// server answered and could not do the work. Telling that student to check
// their internet is a lie that sends them rebooting a router.
function isServerFailure(error: unknown) {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === "number" && status >= 500;
}

const SERVER_BUSY_MESSAGE =
  "Sua's server is busy — your work is safe on this device.";

/**
 * Run `fn` over `items` with at most `limit` in flight, settling every item so
 * one failure cannot cancel the others. Like `Promise.allSettled`, an entry
 * never rejects out of the returned array.
 */
async function mapLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(limit, items.length)) },
      () => worker(),
    ),
  );
  return results;
}

async function getTokenWithTimeout(
  getToken: (options?: { skipCache?: boolean }) => Promise<string | null>,
  options?: { skipCache?: boolean },
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getToken(options).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TOKEN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function serverCourseToLocal(course: ServerCourse): Course {
  return {
    id: course.id,
    code: course.code ?? "",
    name: course.name,
    lecturer: course.lecturer ?? "",
    color: course.colour,
    examDate: course.examDate,
    noteCount: 0,
    archived: course.archived,
  };
}

function serverProfileToLocal(profile: ServerProfile): UserProfile {
  return {
    name: profile.name ?? "",
    email: profile.email,
    university: profile.university ?? "",
    programme: profile.programme ?? "",
    level: profile.level ?? "",
    plan: profile.plan,
    planExpiresAt: profile.planExpiresAt,
    usage: profile.usage ?? undefined,
  };
}

function serverCourseToCache(course: ServerCourse): Omit<LocalCourse, "updatedAt"> {
  return {
    id: course.id,
    name: course.name,
    code: course.code ?? "",
    colour: course.colour,
    lecturer: course.lecturer ?? "",
    examDate: course.examDate,
    archived: course.archived,
  };
}

function cachedCourseToApp(course: LocalCourse): Course {
  return {
    id: course.id,
    code: course.code,
    name: course.name,
    lecturer: course.lecturer,
    color: course.colour,
    examDate: course.examDate,
    noteCount: 0,
    archived: course.archived,
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const {
    isLoaded,
    isSignedIn: isSignedInRaw,
    getToken: clerkGetToken,
    userId,
  } = useAuth();
  // @clerk/expo rebuilds `getToken` as a plain arrow function on every render
  // (its own useCallback-free wrapper around @clerk/react's memoised one, added
  // to fill SessionJWTCache). Handing that straight to an effect dependency
  // array re-fires the whole post-sign-in request burst on every render of this
  // provider — and the burst sets state, so it keeps re-firing itself, which is
  // how /api/me ends up queueing behind dozens of its own transactions. Clerk
  // reads session state at call time, so delegating through a ref keeps the
  // behaviour identical while giving the effects a dependency that holds still.
  const clerkGetTokenRef = useRef(clerkGetToken);
  useEffect(() => {
    clerkGetTokenRef.current = clerkGetToken;
  }, [clerkGetToken]);
  const getToken = useCallback(
    (options?: { skipCache?: boolean }) => clerkGetTokenRef.current(options),
    [],
  );
  // Two readings of the same snapshot:
  // - `signedInNow` is Clerk's raw answer, used by the data effects so a real
  //   sign-out stops hydration immediately;
  // - `authVerdict` debounces it, so one "signed out" frame (token refresh,
  //   native client sync, five-minute poll) never looks like a logout.
  const signedInNow = isSignedInRaw === true;
  const authVerdict = useAuthVerdict(isLoaded, isSignedInRaw);
  const isSignedIn = authVerdict === "signed-in";
  const isSignedOut = authVerdict === "signed-out";
  const [signOutRequested, setSignOutRequested] = useState(false);
  // Derived, not stored: an explicit sign-out only "counts" until a session
  // exists again, and deriving it keeps the effect-free lint rule happy.
  const isSigningOut = signOutRequested && !signedInNow;
  // Positive evidence from a completed auth flow. Derived, not stored: the
  // debounced verdict posting "signed-in" disposes of it, so no effect is
  // needed; the 20s timer keeps a wedged sync from holding auth-finish
  // forever. (Raw state exists only because sign-out must clear it actively.)
  const [authClaimPendingRaw, setAuthClaimPending] = useState(false);
  const authClaimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markAuthClaim = useCallback(() => {
    setAuthClaimPending(true);
    if (authClaimTimer.current) clearTimeout(authClaimTimer.current);
    authClaimTimer.current = setTimeout(() => {
      authClaimTimer.current = null;
      setAuthClaimPending(false);
    }, AUTH_CLAIM_MAX_MS);
  }, []);
  // A completed sign-in outranks a stale verdict only until "signed in" itself
  // is published.
  const isAuthClaimPending = authClaimPendingRaw && authVerdict !== "signed-in";
  const { signOut: clerkSignOut } = useClerk();
  const { user } = useUser();
  const db = useSQLiteContext();
  const [hydrated, setHydrated] = useState<HydratedState>(EMPTY_HYDRATED);

  const getAuthToken = useCallback(() => getToken(), [getToken]);

  // Re-runs hydration (profile + courses + note sync + pull) on demand.
  // Connectivity and foreground events bump it; a failed sync schedules one
  // bounded retry so queued edits resume without waiting for an app restart.
  const [refreshTick, setRefreshTick] = useState(0);
  // Tagged with the account so a late response for a previous session is never
  // displayed under the new one.
  const [streakState, setStreakState] = useState<{
    userId: string;
    value: AppStreak;
  } | null>(null);
  const [hydrationIssue, setHydrationIssue] = useState(false);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [authRejected, setAuthRejected] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);
  // A session can exist in Clerk before it can mint a token (the native client
  // syncs into the JS client asynchronously). Counting the misses keeps the
  // retry bounded instead of spinning forever.
  const tokenMisses = useRef(0);
  // The burst currently in flight, or null once it has settled. The fallback
  // timer checks it when it fires: every step of an attempt is bounded (10s
  // token race, 15s /me), so a request that is merely slow must never be
  // reported as "still connecting". It is also what keeps two bursts from
  // overlapping for one account — see the guard in the hydration effect. A ref,
  // not state: nothing renders from it.
  const activeAttempt = useRef<HydrationAttempt | null>(null);
  // Own timer, not `requestRefresh`: that helper drops a delayed request when
  // another timer is already pending, which would silently swallow the retry.
  const tokenRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A hydration snapshot only describes the state it was requested for. Local
  // writes bump this so a response already in flight cannot overwrite a newer
  // server write (finishing onboarding, adding a course...).
  const hydrationRevision = useRef(0);
  const bumpHydrationRevision = useCallback(() => {
    hydrationRevision.current += 1;
  }, []);
  // Once the server confirms an account is onboarded in this session, no later
  // snapshot may undo that: a brief "home then setup" bounce is the regression
  // this guarantees against, and re-onboarding an existing student is never
  // the right answer.
  const [confirmedOnboardedFor, setConfirmedOnboardedFor] = useState<
    string | null
  >(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRefresh = useCallback((delayMs = 0) => {
    if (delayMs <= 0) {
      setRefreshTick((tick) => tick + 1);
      return;
    }
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      setRefreshTick((tick) => tick + 1);
    }, delayMs);
  }, []);
  const retryStep = useRef(0);
  const scheduleHydrationRetry = useCallback(() => {
    const step = Math.min(
      retryStep.current,
      HYDRATION_RETRY_DELAYS_MS.length - 1,
    );
    retryStep.current += 1;
    // Jitter so a fleet of devices that failed on the same server hiccup does
    // not come back in lockstep and repeat the burst that just failed.
    requestRefresh(
      HYDRATION_RETRY_DELAYS_MS[step] + Math.floor(Math.random() * 2_000),
    );
  }, [requestRefresh]);
  const retryHydration = useCallback(() => {
    // A manual retry is a fresh start: clear the "server rejected the session"
    // verdict and the previous attempt's message so the screen can show
    // progress instead of the old failure copy.
    tokenMisses.current = 0;
    retryStep.current = 0;
    setAuthRejected(false);
    setServerBusy(false);
    setHydrationError(null);
    requestRefresh();
  }, [requestRefresh]);
  const applyHydrationFallback = useCallback((clerkId: string) => {
    setHydrated((previous) => {
      if (previous.clerkId === clerkId && previous.profile) return previous;
      return { clerkId, profile: null, courses: [] };
    });
    setHydrationIssue(true);
    // The bootstrap request is normally still in flight when this fires (a cold
    // API + Neon start can take ~10s), and it will hydrate the app the moment
    // it lands. So this must not announce a failure: keep whatever the request
    // itself reported, and otherwise say we are still connecting.
    setHydrationError((previous) =>
      previous ??
      (__DEV__
        ? `Still connecting to ${API_BASE_URL}…`
        : "Still connecting to Sua…"),
    );
    void listLocalCourses(db)
      .then((cached) => {
        setHydrated((previous) =>
          previous.clerkId === clerkId && !previous.profile
            ? { ...previous, courses: cached.map(cachedCourseToApp) }
            : previous,
        );
      })
      .catch(() => {});
  }, [db]);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (tokenRetryTimer.current) clearTimeout(tokenRetryTimer.current);
    },
    [],
  );

  // Network-backed bootstrap must not block the signed-in app forever. After
  // a bounded wait, expose cached courses and let connectivity/foreground
  // events retry the server bootstrap in the background. The timer checks
  // `activeAttempt` when it fires, so a slow-but-working attempt is never
  // mistaken for a hang: its real job is covering an attempt that stopped
  // without ever claiming the ref. `refreshTick` re-arms it after an attempt
  // that settled without setting anything (the token-miss retries).
  useEffect(() => {
    if (!isLoaded || !signedInNow || !userId || hydrated.clerkId === userId) {
      return;
    }
    const timeout = setTimeout(() => {
      if (activeAttempt.current) return;
      applyHydrationFallback(userId);
    }, 15_000);
    return () => clearTimeout(timeout);
  }, [applyHydrationFallback, hydrated.clerkId, isLoaded, refreshTick, signedInNow, userId]);

  // Flush the note queue and pull fresh copies whenever connectivity returns
  // or the app returns to the foreground — the queue must not wait for a
  // restart to drain.
  //
  // Only `requestRefresh` here: the hydration burst it triggers already runs
  // the upload, generation, reconcile and progress queues. Firing them from the
  // listener too stacks a second, unguarded set of requests on top of a burst
  // that is still in flight, and each one opens its own database transaction.
  useEffect(() => {
    let sawInitialNetInfo = false;
    const unsubscribeNet = NetInfo.addEventListener((state) => {
      if (!sawInitialNetInfo) {
        // The first event just reports the current state; the hydration
        // effect already runs on mount.
        sawInitialNetInfo = true;
        return;
      }
      if (state.isConnected) requestRefresh();
    });
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") requestRefresh();
    });
    return () => {
      unsubscribeNet();
      appState.remove();
    };
  }, [requestRefresh]);

  // Push registration is explicit (profile -> Notifications). Once opted in,
  // keep the server row in step for this session: re-register if a sign-out
  // released the token, and follow Expo token rollover without a restart.
  // Permission is already granted, so re-registering never prompts; Expo Go and
  // emulators without Play services simply never emit a token.
  useEffect(() => {
    if (!isLoaded || !signedInNow || !userId) return;
    let cancelled = false;
    let subscription: { remove: () => void } | null = null;
    void (async () => {
      if ((await getSetting(db, "push_enabled")) !== "1" || cancelled) return;
      const stored = await getSetting(db, "expo_push_token").catch(() => null);
      if (!stored && !cancelled) {
        const expoToken = await registerForPushAndReport();
        if (expoToken && !cancelled) {
          await setSetting(db, "expo_push_token", expoToken).catch(() => {});
          const token = await getToken().catch(() => null);
          if (token) {
            await pushApi
              .registerToken(token, expoToken, Platform.OS === "ios" ? "ios" : "android")
              .catch(() => {});
          }
        }
      }
      subscription = addPushTokenRefreshListener((expoToken) => {
        void setSetting(db, "expo_push_token", expoToken).catch(() => {});
        void getToken()
          .then((token) => {
            if (token) {
              pushApi
                .registerToken(token, expoToken, Platform.OS === "ios" ? "ios" : "android")
                .catch(() => {});
            }
          })
          .catch(() => {});
      });
    })();
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [db, getToken, isLoaded, signedInNow, userId]);

  // Daily streak: queue today's open and paint the offline estimate. The
  // network half belongs to the hydration burst (its tail), which posts it
  // after the note pulls — `POST /me/activity` takes a row lock on the user,
  // and running it alongside the pulls competes with every one of them for it.
  // `refreshTick` stays in the deps for the *local* repaint only: on a new day
  // with no connection the burst tail never runs, and this is what stops Home
  // showing yesterday's count.
  useEffect(() => {
    if (!isLoaded || !signedInNow || !userId) return;
    let cancelled = false;
    void (async () => {
      await recordAppOpen(db, userId).catch(() => {});
      const [cache, pending] = await Promise.all([
        readCachedStreak(db, userId),
        readPendingDays(db, userId),
      ]);
      if (cancelled) return;
      setStreakState({
        userId,
        value: optimisticStreak(cache, pending, localDayKey()),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [db, isLoaded, refreshTick, signedInNow, userId]);

  useEffect(() => {
    let cancelled = false;
    if (!isLoaded || !signedInNow || !userId) return;
    if (activeAttempt.current?.userId === userId) {
      // A burst for this account is already running (foreground, reconnect or a
      // retry timer asked for another pass while one was in flight). Record the
      // request and let the running attempt start it when it settles, instead of
      // firing a second burst on top of the first — those requests each open a
      // database transaction, and stacking them is what starves the pool.
      activeAttempt.current.refreshWanted = true;
      return;
    }
    const revision = hydrationRevision.current;
    const attempt: HydrationAttempt = { userId, refreshWanted: false };
    activeAttempt.current = attempt;
    (async () => {
      try {
        let token = await getTokenWithTimeout(getToken);
        if (cancelled) return;
        if (!token) {
          // Clerk has a session but has not minted a token yet. Returning
          // silently used to leave the student on the /auth-finish spinner for
          // the whole fallback window; retry a few times instead.
          if (__DEV__) {
            console.log(
              `[hydration] no session token yet (attempt ${tokenMisses.current + 1}/3) from ${API_BASE_URL}`,
            );
          }
          if (tokenMisses.current < 3) {
            tokenMisses.current += 1;
            if (tokenRetryTimer.current) clearTimeout(tokenRetryTimer.current);
            tokenRetryTimer.current = setTimeout(() => {
              tokenRetryTimer.current = null;
              setRefreshTick((tick) => tick + 1);
            }, 1_500);
          } else {
            setHydrationIssue(true);
            setAuthRejected(true);
            setServerBusy(false);
            setHydrationError(
              "Sua could not read your session. Sign out and sign in again.",
            );
            setHydrated((prev) =>
              prev.clerkId === userId && prev.profile
                ? prev
                : { clerkId: userId, profile: null, courses: [] },
            );
          }
          return;
        }
        tokenMisses.current = 0;

        // Bootstrap the local User row before loading dependent courses. Both
        // endpoints lazily create the row, so running them concurrently can
        // race on the users.clerkId unique constraint for a new account.
        let profile: ServerProfile;
        try {
          profile = await profileApi.get(token, {
            timeoutMs: BOOTSTRAP_TIMEOUT_MS,
          });
        } catch (error) {
          // A token can rotate between the read and the request; one forced
          // refresh absorbs that race. A second 401 is a real rejection.
          if ((error as { status?: number } | null)?.status !== 401) throw error;
          const fresh = await getTokenWithTimeout(getToken, { skipCache: true });
          if (!fresh) throw error;
          token = fresh;
          profile = await profileApi.get(token, {
            timeoutMs: BOOTSTRAP_TIMEOUT_MS,
          });
        }
        if (cancelled) return;
        if (__DEV__) {
          console.log(`[hydration] profile loaded from ${API_BASE_URL}`);
        }
        // A newer local write already happened: this snapshot is older than the
        // truth on the server, so applying it would undo that write.
        if (hydrationRevision.current !== revision) return;
        // The server folds "has any data" into `onboarded`, so the profile
        // alone settles the routing verdict.
        const onboarded = Boolean(
          profile.onboarded ?? profile.onboardingCompletedAt,
        );
        // Sticky: set before the state lands so a snapshot that arrives while
        // setup is on screen can never flip the verdict back to "new account".
        if (onboarded) setConfirmedOnboardedFor(userId);
        // The profile is the routing verdict, so it lands before the course
        // list: a slow or failing /courses must never hold the resolver on
        // the connect screen.
        setHydrated((prev) =>
          prev.clerkId === userId
            ? { ...prev, profile }
            : { clerkId: userId, profile, courses: [] },
        );
        // A fallback that fired before this attempt landed left the
        // "reconnecting" banner behind; the profile clears it.
        setHydrationIssue(false);
        setHydrationError(null);
        setAuthRejected(false);
        setServerBusy(false);
        // The server answered: later failures start the ladder over at 15s
        // rather than inheriting a long backoff from a resolved problem.
        retryStep.current = 0;
        // Keep the offline fallback fresh: an onboarded account may sign in
        // without a connection next time and should go straight to the app.
        // Written here, not after the course list, so a later /courses failure
        // cannot cost the account its offline verdict.
        void writeOnboardedCache(db, userId, onboarded);

        let coursesFailure: unknown = null;
        const serverCourses = await coursesApi
          .list(token)
          .catch((error: unknown) => {
            coursesFailure = error;
            return null;
          });
        if (cancelled) return;
        if (!serverCourses) {
          // Degrade, do not fail: the profile already routed the student into
          // the app, so keep it, fall back to the cached course list and let
          // the reconnect banner offer a retry.
          if (hydrationRevision.current !== revision) return;
          setHydrationIssue(true);
          setServerBusy(isServerFailure(coursesFailure));
          let cached: LocalCourse[] = [];
          try {
            cached = await listLocalCourses(db);
          } catch {
            // Local cache unreadable — an empty course list is still safe.
          }
          if (cancelled) return;
          setHydrated((prev) =>
            prev.clerkId === userId && prev.profile
              ? { ...prev, courses: cached.map(cachedCourseToApp) }
              : prev,
          );
          scheduleHydrationRetry();
          return;
        }
        // A newer local write happened while the courses were loading.
        if (hydrationRevision.current !== revision) return;
        setHydrated((prev) =>
          prev.clerkId === userId
            ? { ...prev, courses: serverCourses.map(serverCourseToLocal) }
            : prev,
        );
        // Keep the offline fallback fresh: an onboarded account may sign in
        // without a connection next time and should go straight to the app.
        // Mirror courses into SQLite so an offline cold start can still list
        // them (and therefore create notes) without the API.
        void replaceLocalCourses(db, serverCourses.map(serverCourseToCache)).catch(() => {});
        // Pushes and reads are independent: a failing sync must not stop the
        // note pulls that carry AI-written bodies (and a failed pull must not
        // hold the push queue hostage).
        try {
          await syncPendingNotes(db, token);
        } catch (error) {
          // Surfaced in the dev console: the note list shows "Waiting to sync",
          // so the reason the queue is stuck otherwise never leaves the device.
          console.warn(
            "note sync failed:",
            error instanceof Error ? error.message : String(error),
          );
          if (!cancelled) scheduleHydrationRetry();
        }
        // Bounded fan-out, incremental. `readNotesPullCursor` is null on the
        // first pass after an install or an account switch, which is exactly the
        // full download a device with no notes cached needs.
        const pullSince = await readNotesPullCursor(db, userId).catch(() => null);
        const watermarks: (string | null)[] = [];
        const pullFailures: unknown[] = [];
        const pullResults = await mapLimited(
          serverCourses,
          COURSE_PULL_CONCURRENCY,
          async (course) => {
            watermarks.push(
              await pullCourseNotes(db, token, course.id, pullSince),
            );
          },
        );
        for (const result of pullResults) {
          if (result.status === "rejected") pullFailures.push(result.reason);
        }
        // After the notes: apply deletions made on other devices, which the
        // course pull cannot express (a missing note is indistinguishable
        // from one this device has not created yet).
        await pullTombstones(db, token, userId).catch((error: unknown) => {
          pullFailures.push(error);
        });
        if (pullFailures.length) {
          // Reachable server but the pull failed (transient): retry soon
          // instead of waiting for the next reconnect or foreground event.
          if (isServerFailure(pullFailures[0])) {
            setHydrationIssue(true);
            setServerBusy(true);
            setHydrationError(SERVER_BUSY_MESSAGE);
          }
          if (!cancelled) scheduleHydrationRetry();
        } else if (hydrationRevision.current === revision) {
          // Only a pass that applied every course *and* the deletions moves the
          // window; a partial pass re-downloads everything next time. Slow, but
          // a cursor that outran a failure would hide notes forever.
          void advanceNotesPullCursor(db, userId, watermarks);
        }
        // Notes first (a queued upload may reference a note still in the
        // push queue), then drain the upload queue — both self-gate offline.
        if (!cancelled) {
          // Last, because `POST /me/activity` takes a lock on the user row the
          // pulls just read. `recordAppOpen` runs first so today's open is in
          // the local queue before it is submitted (it is idempotent, so the
          // streak effect's own call is harmless).
          void recordAppOpen(db, userId)
            .catch(() => {})
            .then(() => syncAppStreak({ db, getAuthToken, userId }))
            .then((synced) => {
              if (!cancelled && synced) setStreakState({ userId, value: synced });
            })
            .catch(() => {});
          void flushUploads({ db, getAuthToken });
          void drainGenerationQueue({
            db,
            getAuthToken,
            onNoteChange: () => requestRefresh(2_000),
          }).catch(() => {});
          // Upload conversions finish server-side; pull any study set whose
          // outputs never reached this device.
          void reconcileAiOutputs({
            db,
            getAuthToken,
            onNoteChange: () => requestRefresh(2_000),
          }).catch(() => {});
          void flushStudyProgress({ db, getAuthToken }).catch(() => {});
        }
      } catch (error) {
        // Backend unreachable. Fall back to the cached course list so notes
        // can still be created and viewed offline; keep any state already
        // hydrated by an earlier successful pass.
        if (cancelled) return;
        // A 401 is not a connectivity problem: the server received the token
        // and refused it. A 5xx is not one either: the server answered, and its
        // own work failed. Saying "check your internet" for either sends
        // students in circles, so keep the three verdicts apart.
        const rejected = (error as { status?: number } | null)?.status === 401;
        const busy = isServerFailure(error);
        if (__DEV__) {
          console.warn(
            `[hydration] failed (status ${(error as { status?: number } | null)?.status ?? "none"}) from ${API_BASE_URL}:`,
            error instanceof Error ? error.message : error,
          );
        }
        setHydrationIssue(true);
        setAuthRejected(rejected);
        setServerBusy(busy);
        setHydrationError(
          rejected
            ? "Sua could not confirm your session with the server. Sign out and sign in again."
            : busy
              ? SERVER_BUSY_MESSAGE
              : // Nothing below this line reached the server, so the message is
                // genuinely about the connection (and in dev, about which URL).
                error instanceof Error && error.message
                ? error.message
                : "Could not check your account.",
        );
        let cached: LocalCourse[] = [];
        try {
          cached = await listLocalCourses(db);
        } catch {
          // Local cache unreadable — an empty course list is still safe.
        }
        setHydrated((prev) =>
          prev.clerkId === userId && prev.profile
            ? prev
            : { clerkId: userId, profile: null, courses: cached.map(cachedCourseToApp) },
        );
      } finally {
        // Released by ownership, not by `cancelled`: an attempt that was
        // cancelled mid-flight is still the one a deferred refresh is waiting
        // on, and a newer attempt's claim on the ref is never clobbered here.
        if (activeAttempt.current === attempt) {
          activeAttempt.current = null;
          if (attempt.refreshWanted) requestRefresh();
        }
      }
    })();
    return () => {
      cancelled = true;
      // The attempt ref is deliberately not touched here. This run's attempt is
      // still in flight and owns it; releasing it is the body's job, and the
      // only way a deferred refresh is guaranteed to run.
    };
  }, [
    db,
    getAuthToken,
    getToken,
    isLoaded,
    scheduleHydrationRetry,
    signedInNow,
    requestRefresh,
    refreshTick,
    userId,
  ]);

  // Derive per-user state from `hydrated` instead of clearing it in an
  // effect: switching/losing the session instantly hides stale data.
  const active = hydrated.clerkId === userId && userId ? hydrated : EMPTY_HYDRATED;
  const isHydrating = signedInNow && Boolean(userId) && !active.clerkId;

  const signOut = useCallback(async () => {
    // Routing must not "self-heal" the welcome screen back to /auth-finish
    // while an explicit sign-out is still settling.
    setSignOutRequested(true);
    // An explicit sign-out ends any outstanding sign-in claim: auth-finish
    // must not hold for a session this student just abandoned.
    if (authClaimTimer.current) {
      clearTimeout(authClaimTimer.current);
      authClaimTimer.current = null;
    }
    setAuthClaimPending(false);
    // Release this device's push token best-effort: study pushes for a signed
    // out account make no sense, and the row would leak across sessions.
    const expoToken = await getSetting(db, "expo_push_token").catch(() => null);
    try {
      if (expoToken) {
        const token = await getToken().catch(() => null);
        if (token) {
          await profileApi.deletePushToken(token, expoToken).catch(() => {});
        }
      }
      await setSetting(db, "expo_push_token", "").catch(() => {});
      // Last chance to push edits made offline. Bounded so an unreachable API
      // can never hold the sign-out (and the spinner) for the full timeout.
      await Promise.race([
        getToken()
          .then((token) => (token ? syncPendingNotes(db, token) : null))
          .catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      bumpHydrationRevision();
      setConfirmedOnboardedFor(null);
      setHydrated(EMPTY_HYDRATED);
      // The next session starts from a clean slate; a rejection recorded for
      // the previous one must not tint its screens.
      tokenMisses.current = 0;
      setAuthRejected(false);
      setServerBusy(false);
      setHydrationIssue(false);
      setHydrationError(null);
      await clerkSignOut();
      // A session that ended on purpose must not keep the flag: otherwise the
      // next genuine expiry reads as "the student signed out" and the welcome
      // screen loses its "session ended" message and its self-heal.
      setSignOutRequested(false);
      // Sign-out is also an account switch: the next student on this device
      // must not inherit notes, cards, reviews or recordings. Only runs once
      // the session is really gone (a failed sign-out keeps the data), and
      // after the best-effort sync above so unsynced work is not thrown away.
      await clearStudyDataForAccountSwitch(db).catch((error: unknown) => {
        console.warn("[sign-out] could not clear local study data", error);
      });
    } catch (error) {
      // Still signed in: let the guards work normally again.
      setSignOutRequested(false);
      throw error;
    }
  }, [bumpHydrationRevision, clerkSignOut, db, getToken]);

  const updateProfile = useCallback(
    async (changes: Partial<UserProfile>) => {
      const token = await getToken();
      if (!token || !userId) throw new Error("Not signed in");
      const profile = await profileApi.update(token, {
        ...(changes.name !== undefined
          ? { name: changes.name || null }
          : {}),
        ...(changes.university !== undefined
          ? { university: changes.university || null }
          : {}),
        ...(changes.programme !== undefined
          ? { programme: changes.programme || null }
          : {}),
        ...(changes.level !== undefined ? { level: changes.level || null } : {}),
      });
      bumpHydrationRevision();
      setHydrated((prev) => ({
        ...prev,
        clerkId: userId,
        // PATCH /me omits usage; keep the counters already hydrated so the free
        // plan meter on Home does not disappear after editing the profile.
        // Merge so a response without onboarded/hasData cannot wipe the verdict.
        profile: { ...prev.profile, ...profile, usage: prev.profile?.usage ?? null },
      }));
    },
    [bumpHydrationRevision, getToken, userId],
  );

  // Server-side wipe (rows + storage objects, then the Clerk account). The
  // local SQLite wipe and sign-out are the caller's job because they must run
  // after the request completes, and only the profile flow knows the steps.
  const deleteAccount = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error("Not signed in");
    await profileApi.deleteAccount(token);
  }, [getToken]);

  const completeOnboarding = useCallback(
    async (nextProfile: UserProfile, firstCourse: Omit<Course, "id">) => {
      const token = await getToken();
      if (!token || !userId) throw new Error("Not signed in");
      // Ensure the User row is created before the course request. This avoids
      // two first-login requests racing to create the same Clerk-backed user.
      await profileApi.get(token);
      const profile = await profileApi.update(token, {
        name: nextProfile.name || null,
        university: nextProfile.university || null,
        programme: nextProfile.programme || null,
        level: nextProfile.level || null,
        onboardingCompleted: true,
      });
      const course = await coursesApi.create(token, {
        name: firstCourse.name,
        code: firstCourse.code || null,
        colour: firstCourse.color,
        lecturer: firstCourse.lecturer || null,
        examDate: firstCourse.examDate || null,
      });
      void upsertLocalCourse(db, serverCourseToCache(course)).catch(() => {});
      bumpHydrationRevision();
      setConfirmedOnboardedFor(userId);
      setHydrated((prev) => ({
        clerkId: userId,
        // The server just accepted the flag: hold the verdict locally even if
        // the response (or a snapshot racing this write) lacks the field.
        profile: {
          ...profile,
          onboarded: true,
          onboardingCompletedAt:
            profile.onboardingCompletedAt ?? new Date().toISOString(),
        },
        courses: prev.courses.some((c) => c.id === course.id)
          ? prev.courses
          : [...prev.courses, serverCourseToLocal(course)],
      }));
      void writeOnboardedCache(db, userId, true);
    },
    [bumpHydrationRevision, db, getToken, userId],
  );

  const addCourse = useCallback(
    async (course: Omit<Course, "id">) => {
      const token = await getToken();
      if (!token || !userId) throw new Error("Not signed in");
      const created = await coursesApi.create(token, {
        name: course.name,
        code: course.code || null,
        colour: course.color,
        lecturer: course.lecturer || null,
        examDate: course.examDate || null,
      });
      void upsertLocalCourse(db, serverCourseToCache(created)).catch(() => {});
      bumpHydrationRevision();
      setHydrated((prev) => ({
        ...prev,
        clerkId: userId,
        courses: [...prev.courses, serverCourseToLocal(created)],
      }));
    },
    [bumpHydrationRevision, db, getToken, userId],
  );

  const updateCourse = useCallback(
    async (id: string, changes: Partial<Course>) => {
      const payload: Parameters<typeof coursesApi.update>[2] = {};
      if (changes.name !== undefined) payload.name = changes.name;
      if (changes.code !== undefined) payload.code = changes.code || null;
      if (changes.color !== undefined) payload.colour = changes.color;
      if (changes.lecturer !== undefined) payload.lecturer = changes.lecturer || null;
      if (changes.examDate !== undefined) payload.examDate = changes.examDate || null;
      if (changes.archived !== undefined) payload.archived = changes.archived;
      const token = await getToken();
      if (!token || !userId) throw new Error("Not signed in");
      const updated = await coursesApi.update(token, id, payload);
      void upsertLocalCourse(db, serverCourseToCache(updated)).catch(() => {});
      bumpHydrationRevision();
      setHydrated((prev) => ({
        ...prev,
        clerkId: userId,
        courses: prev.courses.map((course) =>
          course.id === id ? serverCourseToLocal(updated) : course,
        ),
      }));
    },
    [bumpHydrationRevision, db, getToken, userId],
  );

  const deleteCourse = useCallback(
    async (id: string, moveNotesToCourseId?: string) => {
      const token = await getToken();
      if (!token || !userId) throw new Error("Not signed in");
      if (moveNotesToCourseId) {
        const notes = await listNotes(db, id);
        for (const note of notes) {
          await saveNote(db, {
            id: note.id,
            courseId: moveNotesToCourseId,
            title: note.title,
            body: note.body,
            sourceType: note.sourceType,
            sourceRef: note.sourceRef,
            noteKind: note.noteKind,
          });
        }
      }
      await coursesApi.remove(token, id, moveNotesToCourseId);
      if (!moveNotesToCourseId) {
        // Server cascades the course's notes; drop the local copies and their
        // queued sync changes so nothing syncs orphans afterwards.
        await purgeCourseLocally(db, id);
      }
      await removeLocalCourse(db, id).catch(() => {});
      bumpHydrationRevision();
      setHydrated((prev) => ({
        ...prev,
        clerkId: userId,
        courses: prev.courses.filter((course) => course.id !== id),
      }));
    },
    [bumpHydrationRevision, db, getToken, userId],
  );

  // A delete must reach the server immediately when the device is online; the
  // reconnect/foreground listeners only fire on the *next* transition.
  const flushNoteQueue = useCallback(async () => {
    // Best-effort by contract: callers fire it without awaiting, and a failed
    // push simply leaves the delete queued for the next reconnect pass.
    const token = await getToken().catch(() => null);
    if (!token || !userId) return;
    await syncPendingNotes(db, token).catch(() => {});
    await pullTombstones(db, token, userId).catch(() => {});
  }, [db, getToken, userId]);

  // Pull-to-refresh forces a fresh server read so another device's open (or a
  // missed sweep) is reflected without waiting for the next day.
  const refreshAppStreak = useCallback(async () => {
    if (!userId) return;
    const synced = await syncAppStreak({
      db,
      getAuthToken,
      userId,
      force: true,
    }).catch(() => null);
    if (synced) setStreakState({ userId, value: synced });
  }, [db, getAuthToken, userId]);

  const appStreak =
    streakState && userId && streakState.userId === userId
      ? streakState.value
      : EMPTY_APP_STREAK;

  const profile = useMemo<UserProfile | null>(() => {
    if (active.profile) return serverProfileToLocal(active.profile);
    if (signedInNow && user) {
      return {
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || "",
        email: user.primaryEmailAddress?.emailAddress ?? "",
        university: "",
        programme: "",
        level: "",
      };
    }
    return null;
  }, [active.profile, user, signedInNow]);

  const isProfileResolved = Boolean(active.profile);
  // The server verdict wins; the local fallback keeps a server that predates
  // the field (or an old cached profile) from re-onboarding existing accounts.
  // The sticky confirmation outlives a lone snapshot disagreeing with it.
  const hasCompletedOnboarding =
    (Boolean(userId) && confirmedOnboardedFor === userId) ||
    Boolean(
      active.profile?.onboarded ??
        (active.profile?.onboardingCompletedAt || active.courses.length > 0),
    );

  const value = useMemo<AppContextValue>(
    () => ({
      isLoaded,
      authVerdict,
      isSignedIn,
      isSignedOut,
      isSigningOut,
      isAuthClaimPending,
      markAuthClaim,
      isHydrating,
      hydrationIssue,
      hydrationError,
      authRejected,
      serverBusy,
      isProfileResolved,
      hasCompletedOnboarding,
      profile,
      courses: active.courses,
      appStreak,
      refreshAppStreak,
      getAuthToken,
      retryHydration,
      flushNoteQueue,
      signOut,
      updateProfile,
      deleteAccount,
      completeOnboarding,
      addCourse,
      updateCourse,
      deleteCourse,
    }),
    [
      active.courses,
      addCourse,
      appStreak,
      authRejected,
      authVerdict,
      completeOnboarding,
      deleteAccount,
      deleteCourse,
      flushNoteQueue,
      getAuthToken,
      hasCompletedOnboarding,
      hydrationError,
      hydrationIssue,
      isHydrating,
      isLoaded,
      isProfileResolved,
      isSignedIn,
      isSignedOut,
      isSigningOut,
      isAuthClaimPending,
      markAuthClaim,
      profile,
      refreshAppStreak,
      retryHydration,
      serverBusy,
      signOut,
      updateCourse,
      updateProfile,
    ],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}
