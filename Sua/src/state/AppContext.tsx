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
import { AppState } from "react-native";
import { coursesApi, profileApi, pushApi } from "../lib/api";
import { useSQLiteContext } from "expo-sqlite";
import {
  getSetting,
  listNotes,
  listLocalCourses,
  pullCourseNotes,
  pullTombstones,
  purgeCourseLocally,
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
import { registerForPushAndReport } from "../lib/notifications";
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
  isHydrating: boolean;
  hydrationIssue: boolean;
  hydrationError: string | null;
  // True once a server profile was hydrated. Routing must not treat an
  // unresolved profile as "not onboarded".
  isProfileResolved: boolean;
  hasCompletedOnboarding: boolean;
  profile: UserProfile | null;
  courses: Course[];
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
  const { isLoaded, isSignedIn: isSignedInRaw, getToken, userId } = useAuth();
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
  const { signOut: clerkSignOut } = useClerk();
  const { user } = useUser();
  const db = useSQLiteContext();
  const [hydrated, setHydrated] = useState<HydratedState>(EMPTY_HYDRATED);

  const getAuthToken = useCallback(() => getToken(), [getToken]);

  // Re-runs hydration (profile + courses + note sync + pull) on demand.
  // Connectivity and foreground events bump it; a failed sync schedules one
  // bounded retry so queued edits resume without waiting for an app restart.
  const [refreshTick, setRefreshTick] = useState(0);
  const [hydrationIssue, setHydrationIssue] = useState(false);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
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
  const retryHydration = useCallback(() => {
    requestRefresh();
  }, [requestRefresh]);
  const applyHydrationFallback = useCallback((clerkId: string) => {
    setHydrated((previous) => {
      if (previous.clerkId === clerkId && previous.profile) return previous;
      return { clerkId, profile: null, courses: [] };
    });
    setHydrationIssue(true);
    setHydrationError("Sua could not reach the server in time.");
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
    },
    [],
  );

  // Network-backed bootstrap must not block the signed-in app forever. After
  // a bounded wait, expose cached courses and let connectivity/foreground
  // events retry the server bootstrap in the background.
  useEffect(() => {
    if (!isLoaded || !signedInNow || !userId || hydrated.clerkId === userId) {
      return;
    }
    const timeout = setTimeout(() => {
      applyHydrationFallback(userId);
    }, 10_000);
    return () => clearTimeout(timeout);
  }, [applyHydrationFallback, hydrated.clerkId, isLoaded, signedInNow, userId]);

  // Flush the note queue and pull fresh copies whenever connectivity returns
  // or the app returns to the foreground — the queue must not wait for a
  // restart to drain.
  useEffect(() => {
    let sawInitialNetInfo = false;
    const unsubscribeNet = NetInfo.addEventListener((state) => {
      if (!sawInitialNetInfo) {
        // The first event just reports the current state; the hydration
        // effect already runs on mount.
        sawInitialNetInfo = true;
        return;
      }
      if (state.isConnected) {
        requestRefresh();
        void flushUploads({ db, getAuthToken });
        void drainGenerationQueue({ db, getAuthToken }).catch(() => {});
        void reconcileAiOutputs({ db, getAuthToken }).catch(() => {});
        void flushStudyProgress({ db, getAuthToken }).catch(() => {});
      }
    });
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        requestRefresh();
        void flushUploads({ db, getAuthToken });
        void drainGenerationQueue({ db, getAuthToken }).catch(() => {});
        void reconcileAiOutputs({ db, getAuthToken }).catch(() => {});
        void flushStudyProgress({ db, getAuthToken }).catch(() => {});
      }
    });
    return () => {
      unsubscribeNet();
      appState.remove();
    };
  }, [db, getAuthToken, requestRefresh]);

  // Register the Expo push token once per session unless the student turned
  // server pushes off (notification settings); the stored token also powers
  // the "off" path so re-enabling without a restart still needs the value.
  // Needs a development build (Expo Go skips it silently).
  const pushRegistered = useRef(false);
  useEffect(() => {
    if (!signedInNow || userId || pushRegistered.current) return;
    void (async () => {
      if ((await getSetting(db, "push_enabled")) === "0") return;
      const expoToken = await registerForPushAndReport();
      if (!expoToken) return;
      pushRegistered.current = true;
      await setSetting(db, "expo_push_token", expoToken).catch(() => {});
      const token = await getToken();
      if (!token) return;
      pushApi.registerToken(token, expoToken).catch(() => {});
    })();
  }, [signedInNow, userId, getToken, db]);

  useEffect(() => {
    let cancelled = false;
    if (!isLoaded || !signedInNow || !userId) return;
    const revision = hydrationRevision.current;
    (async () => {
      try {
        const token = await getToken();
        if (!token || cancelled) return;
        // Bootstrap the local User row before loading dependent courses. Both
        // endpoints lazily create the row, so running them concurrently can
        // race on the users.clerkId unique constraint for a new account.
        const profile = await profileApi.get(token);
        const serverCourses = await coursesApi.list(token);
        if (cancelled) return;
        // A newer local write already happened: this snapshot is older than the
        // truth on the server, so applying it would undo that write.
        if (hydrationRevision.current !== revision) return;
        const onboarded = Boolean(
          profile.onboarded ??
            (profile.onboardingCompletedAt || serverCourses.length > 0),
        );
        // Sticky: set before the state lands so a snapshot that arrives while
        // setup is on screen can never flip the verdict back to "new account".
        if (onboarded) setConfirmedOnboardedFor(userId);
        setHydrated({
          clerkId: userId,
          profile,
          courses: serverCourses.map(serverCourseToLocal),
        });
        setHydrationIssue(false);
        setHydrationError(null);
        // Keep the offline fallback fresh: an onboarded account may sign in
        // without a connection next time and should go straight to the app.
        void writeOnboardedCache(db, userId, onboarded);
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
          if (!cancelled) requestRefresh(15_000);
        }
        try {
          await Promise.all(
            serverCourses.map((course) => pullCourseNotes(db, token, course.id)),
          );
          // After the notes: apply deletions made on other devices, which the
          // course pull cannot express (a missing note is indistinguishable
          // from one this device has not created yet).
          await pullTombstones(db, token);
        } catch {
          // Reachable server but the pull failed (transient): retry soon
          // instead of waiting for the next reconnect or foreground event.
          if (!cancelled) requestRefresh(15_000);
        }
        // Notes first (a queued upload may reference a note still in the
        // push queue), then drain the upload queue — both self-gate offline.
        if (!cancelled) {
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
        setHydrationIssue(true);
        setHydrationError(
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
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, getAuthToken, getToken, isLoaded, signedInNow, requestRefresh, refreshTick, userId]);

  // Derive per-user state from `hydrated` instead of clearing it in an
  // effect: switching/losing the session instantly hides stale data.
  const active = hydrated.clerkId === userId && userId ? hydrated : EMPTY_HYDRATED;
  const isHydrating = signedInNow && Boolean(userId) && !active.clerkId;

  const signOut = useCallback(async () => {
    // Routing must not "self-heal" the welcome screen back to /auth-finish
    // while an explicit sign-out is still settling.
    setSignOutRequested(true);
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
      bumpHydrationRevision();
      setConfirmedOnboardedFor(null);
      setHydrated(EMPTY_HYDRATED);
      await clerkSignOut();
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
    if (!token) return;
    await syncPendingNotes(db, token).catch(() => {});
    await pullTombstones(db, token).catch(() => {});
  }, [db, getToken]);

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
      isHydrating,
      hydrationIssue,
      hydrationError,
      isProfileResolved,
      hasCompletedOnboarding,
      profile,
      courses: active.courses,
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
      profile,
      retryHydration,
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
