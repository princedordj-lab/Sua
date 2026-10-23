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
import { AppState } from "react-native";
import { coursesApi, profileApi, pushApi } from "../lib/api";
import { useSQLiteContext } from "expo-sqlite";
import {
  getSetting,
  listLocalCourses,
  pullCourseNotes,
  purgeCourseLocally,
  removeLocalCourse,
  replaceLocalCourses,
  setSetting,
  syncPendingNotes,
  upsertLocalCourse,
  type LocalCourse,
} from "../lib/notes";
import { flushUploads } from "../lib/uploads";
import { drainGenerationQueue } from "../lib/generate";
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
  isSignedIn: boolean;
  isHydrating: boolean;
  hydrationIssue: boolean;
  hasCompletedOnboarding: boolean;
  profile: UserProfile | null;
  courses: Course[];
  getAuthToken: () => Promise<string | null>;
  retryHydration: () => void;
  signOut: () => Promise<void>;
  updateProfile: (changes: Partial<UserProfile>) => Promise<void>;
  deleteAccount: () => Promise<void>;
  completeOnboarding: (
    profile: UserProfile,
    firstCourse: Omit<Course, "id">,
  ) => Promise<void>;
  addCourse: (course: Omit<Course, "id">) => Promise<void>;
  updateCourse: (id: string, changes: Partial<Course>) => Promise<void>;
  deleteCourse: (id: string) => Promise<void>;
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
    lecturer: "",
    color: course.colour,
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
  };
}

function serverCourseToCache(course: ServerCourse): Omit<LocalCourse, "updatedAt"> {
  return {
    id: course.id,
    name: course.name,
    code: course.code ?? "",
    colour: course.colour,
    archived: course.archived,
  };
}

function cachedCourseToApp(course: LocalCourse): Course {
  return {
    id: course.id,
    code: course.code,
    name: course.name,
    lecturer: "",
    color: course.colour,
    noteCount: 0,
    archived: course.archived,
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn: isSignedInRaw, getToken, userId } = useAuth();
  const isSignedIn = Boolean(isSignedInRaw);
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
    if (!isLoaded || !isSignedIn || !userId || hydrated.clerkId === userId) {
      return;
    }
    const timeout = setTimeout(() => {
      applyHydrationFallback(userId);
    }, 10_000);
    return () => clearTimeout(timeout);
  }, [applyHydrationFallback, hydrated.clerkId, isLoaded, isSignedIn, userId]);

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
        void flushStudyProgress({ db, getAuthToken });
      }
    });
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        requestRefresh();
        void flushUploads({ db, getAuthToken });
        void drainGenerationQueue({ db, getAuthToken }).catch(() => {});
        void flushStudyProgress({ db, getAuthToken });
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
    if (!isSignedIn || userId || pushRegistered.current) return;
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
  }, [isSignedIn, userId, getToken, db]);

  useEffect(() => {
    let cancelled = false;
    if (!isLoaded || !isSignedIn || !userId) return;
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
        setHydrated({
          clerkId: userId,
          profile,
          courses: serverCourses.map(serverCourseToLocal),
        });
        setHydrationIssue(false);
        // Mirror courses into SQLite so an offline cold start can still list
        // them (and therefore create notes) without the API.
        void replaceLocalCourses(db, serverCourses.map(serverCourseToCache)).catch(() => {});
        try {
          await syncPendingNotes(db, token);
          await Promise.all(
            serverCourses.map((course) => pullCourseNotes(db, token, course.id)),
          );
        } catch {
          // Reachable server but the sync/pull failed (transient): retry soon
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
          void flushStudyProgress({ db, getAuthToken });
        }
      } catch {
        // Backend unreachable. Fall back to the cached course list so notes
        // can still be created and viewed offline; keep any state already
        // hydrated by an earlier successful pass.
        if (cancelled) return;
        setHydrationIssue(true);
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
  }, [db, getAuthToken, getToken, isLoaded, isSignedIn, requestRefresh, refreshTick, userId]);

  // Derive per-user state from `hydrated` instead of clearing it in an
  // effect: switching/losing the session instantly hides stale data.
  const active = hydrated.clerkId === userId && userId ? hydrated : EMPTY_HYDRATED;
  const isHydrating = isSignedIn && Boolean(userId) && !active.clerkId;

  const signOut = useCallback(async () => {
    // Release this device's push token best-effort: study pushes for a signed
    // out account make no sense, and the row would leak across sessions.
    const expoToken = await getSetting(db, "expo_push_token").catch(() => null);
    if (expoToken) {
      const token = await getToken().catch(() => null);
      if (token) {
        await profileApi.deletePushToken(token, expoToken).catch(() => {});
      }
    }
    await setSetting(db, "expo_push_token", "").catch(() => {});
    setHydrated(EMPTY_HYDRATED);
    setHydrationIssue(false);
    await clerkSignOut();
  }, [clerkSignOut, db, getToken]);

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
      setHydrated((prev) => ({
        ...prev,
        clerkId: userId,
        profile,
      }));
    },
    [getToken, userId],
  );

  // Server-side wipe (rows + Cloudinary files, then the Clerk account). The
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
      });
      void upsertLocalCourse(db, serverCourseToCache(course)).catch(() => {});
      setHydrated((prev) => ({
        clerkId: userId,
        profile,
        courses: prev.courses.some((c) => c.id === course.id)
          ? prev.courses
          : [...prev.courses, serverCourseToLocal(course)],
      }));
    },
    [db, getToken, userId],
  );

  const addCourse = useCallback(
    async (course: Omit<Course, "id">) => {
      const token = await getToken();
      if (!token || !userId) throw new Error("Not signed in");
      const created = await coursesApi.create(token, {
        name: course.name,
        code: course.code || null,
        colour: course.color,
      });
      void upsertLocalCourse(db, serverCourseToCache(created)).catch(() => {});
      setHydrated((prev) => ({
        ...prev,
        clerkId: userId,
        courses: [...prev.courses, serverCourseToLocal(created)],
      }));
    },
    [db, getToken, userId],
  );

  const updateCourse = useCallback(
    async (id: string, changes: Partial<Course>) => {
      const payload: Parameters<typeof coursesApi.update>[2] = {};
      if (changes.name !== undefined) payload.name = changes.name;
      if (changes.code !== undefined) payload.code = changes.code || null;
      if (changes.color !== undefined) payload.colour = changes.color;
      if (changes.archived !== undefined) payload.archived = changes.archived;
      const token = await getToken();
      if (!token || !userId) throw new Error("Not signed in");
      const updated = await coursesApi.update(token, id, payload);
      void upsertLocalCourse(db, serverCourseToCache(updated)).catch(() => {});
      setHydrated((prev) => ({
        ...prev,
        clerkId: userId,
        courses: prev.courses.map((course) =>
          course.id === id ? serverCourseToLocal(updated) : course,
        ),
      }));
    },
    [db, getToken, userId],
  );

  const deleteCourse = useCallback(
    async (id: string) => {
      const token = await getToken();
      if (!token || !userId) throw new Error("Not signed in");
      await coursesApi.remove(token, id);
      // Server cascades the course's notes; drop the local copies and their
      // queued sync changes so nothing syncs orphans afterwards.
      await purgeCourseLocally(db, id);
      await removeLocalCourse(db, id).catch(() => {});
      setHydrated((prev) => ({
        ...prev,
        clerkId: userId,
        courses: prev.courses.filter((course) => course.id !== id),
      }));
    },
    [db, getToken, userId],
  );

  const profile = useMemo<UserProfile | null>(() => {
    if (active.profile) return serverProfileToLocal(active.profile);
    if (isSignedIn && user) {
      return {
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || "",
        email: user.primaryEmailAddress?.emailAddress ?? "",
        university: "",
        programme: "",
        level: "",
      };
    }
    return null;
  }, [active.profile, user, isSignedIn]);

  const hasCompletedOnboarding = Boolean(active.profile?.onboardingCompletedAt);

  const value = useMemo<AppContextValue>(
    () => ({
      isLoaded,
      isSignedIn,
      isHydrating,
      hydrationIssue,
      hasCompletedOnboarding,
      profile,
      courses: active.courses,
      getAuthToken,
      retryHydration,
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
      completeOnboarding,
      deleteAccount,
      deleteCourse,
      getAuthToken,
      hasCompletedOnboarding,
      hydrationIssue,
      isHydrating,
      isLoaded,
      isSignedIn,
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
