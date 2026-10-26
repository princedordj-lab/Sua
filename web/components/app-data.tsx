"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useApi } from "@/lib/use-api";
import { useResource } from "@/lib/use-resource";
import type { ServerCourse, ServerProfile } from "@/lib/types";

type AppData = {
  profile: ServerProfile;
  courses: ServerCourse[];
};

type AppDataValue = {
  profile: ServerProfile | null;
  courses: ServerCourse[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  refreshProfile: () => Promise<void>;
  addCourse: (input: Parameters<ReturnType<typeof useApi>["courses"]["create"]>[0]) => Promise<ServerCourse>;
  updateCourse: (
    id: string,
    changes: Parameters<ReturnType<typeof useApi>["courses"]["update"]>[1],
  ) => Promise<ServerCourse>;
  deleteCourse: (id: string, moveToCourseId?: string) => Promise<void>;
};

const AppDataContext = createContext<AppDataValue | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const api = useApi();

  const resource = useResource<AppData>("app-data", async () => {
    const [profile, courses] = await Promise.all([api.profile.get(), api.courses.list()]);
    return { profile, courses };
  });

  const refresh = resource.reload;

  const refreshProfile = useCallback(async () => {
    const profile = await api.profile.get();
    resource.setData((current) => (current ? { ...current, profile } : current));
  }, [api, resource]);

  const addCourse = useCallback<AppDataValue["addCourse"]>(
    async (input) => {
      const course = await api.courses.create(input);
      resource.setData((current) =>
        current ? { ...current, courses: [...current.courses, course] } : current,
      );
      return course;
    },
    [api, resource],
  );

  const updateCourse = useCallback<AppDataValue["updateCourse"]>(
    async (id, changes) => {
      const course = await api.courses.update(id, changes);
      resource.setData((current) =>
        current
          ? {
              ...current,
              courses: current.courses.map((row) => (row.id === course.id ? course : row)),
            }
          : current,
      );
      return course;
    },
    [api, resource],
  );

  const deleteCourse = useCallback<AppDataValue["deleteCourse"]>(
    async (id, moveToCourseId) => {
      await api.courses.remove(id, moveToCourseId);
      resource.setData((current) =>
        current
          ? { ...current, courses: current.courses.filter((row) => row.id !== id) }
          : current,
      );
    },
    [api, resource],
  );

  const value = useMemo<AppDataValue>(
    () => ({
      profile: resource.data?.profile ?? null,
      courses: resource.data?.courses ?? [],
      loading: resource.loading,
      error: resource.error,
      refresh,
      refreshProfile,
      addCourse,
      updateCourse,
      deleteCourse,
    }),
    [
      resource.data,
      resource.loading,
      resource.error,
      refresh,
      refreshProfile,
      addCourse,
      updateCourse,
      deleteCourse,
    ],
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData() {
  const value = useContext(AppDataContext);
  if (!value) throw new Error("useAppData must be used inside AppDataProvider");
  return value;
}
