import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth, useClerk, useUser } from "@clerk/expo";
import { coursesApi, profileApi } from "../lib/api";
import { useSQLiteContext } from "expo-sqlite";
import { pullCourseNotes, syncPendingNotes } from "../lib/notes";
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
  hasCompletedOnboarding: boolean;
  profile: UserProfile | null;
  courses: Course[];
  getAuthToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
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
        try {
          await syncPendingNotes(db, token);
          await Promise.all(
            serverCourses.map((course) => pullCourseNotes(db, token, course.id)),
          );
        } catch {
          // Notes remain in SQLite and the queue; retry on the next hydration.
        }
      } catch {
        // Backend unreachable — record the attempt so guards do not hang;
        // setup can retry persistence when connectivity returns.
        if (!cancelled) {
          setHydrated({ clerkId: userId, profile: null, courses: [] });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, getToken, isLoaded, isSignedIn, userId]);

  // Derive per-user state from `hydrated` instead of clearing it in an
  // effect: switching/losing the session instantly hides stale data.
  const active = hydrated.clerkId === userId && userId ? hydrated : EMPTY_HYDRATED;
  const isHydrating = isSignedIn && Boolean(userId) && !active.clerkId;

  const signOut = useCallback(async () => {
    setHydrated(EMPTY_HYDRATED);
    await clerkSignOut();
  }, [clerkSignOut]);

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
      setHydrated((prev) => ({
        clerkId: userId,
        profile,
        courses: prev.courses.some((c) => c.id === course.id)
          ? prev.courses
          : [...prev.courses, serverCourseToLocal(course)],
      }));
    },
    [getToken, userId],
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
      setHydrated((prev) => ({
        ...prev,
        clerkId: userId,
        courses: [...prev.courses, serverCourseToLocal(created)],
      }));
    },
    [getToken, userId],
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
      setHydrated((prev) => ({
        ...prev,
        clerkId: userId,
        courses: prev.courses.map((course) =>
          course.id === id ? serverCourseToLocal(updated) : course,
        ),
      }));
    },
    [getToken, userId],
  );

  const deleteCourse = useCallback(
    async (id: string) => {
      const token = await getToken();
      if (!token || !userId) throw new Error("Not signed in");
      await coursesApi.remove(token, id);
      setHydrated((prev) => ({
        ...prev,
        clerkId: userId,
        courses: prev.courses.filter((course) => course.id !== id),
      }));
    },
    [getToken, userId],
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
      hasCompletedOnboarding,
      profile,
      courses: active.courses,
      getAuthToken,
      signOut,
      completeOnboarding,
      addCourse,
      updateCourse,
      deleteCourse,
    }),
    [
      active.courses,
      addCourse,
      completeOnboarding,
      deleteCourse,
      getAuthToken,
      hasCompletedOnboarding,
      isHydrating,
      isLoaded,
      isSignedIn,
      profile,
      signOut,
      updateCourse,
    ],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}
