import type {
  NoteSyncChange,
  ServerNote,
  ServerCourse,
  ServerCourseCreate,
  ServerProfile,
  ServerProfileUpdate,
} from "./types";
import { Platform } from "react-native";

const API_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  (Platform.OS === "android" ? "http://10.0.2.2:4000/api" : "http://localhost:4000/api");
type RequestOptions = RequestInit & { token?: string };

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`API request failed (${response.status})`);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const coursesApi = {
  list: (token: string) => apiRequest<ServerCourse[]>("/courses", { token }),
  create: (token: string, course: ServerCourseCreate) =>
    apiRequest<ServerCourse>("/courses", {
      method: "POST",
      token,
      body: JSON.stringify(course),
    }),
  update: (
    token: string,
    id: string,
    changes: Partial<ServerCourseCreate> & { archived?: boolean },
  ) =>
    apiRequest<ServerCourse>(`/courses/${id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(changes),
    }),
  remove: (token: string, id: string) =>
    apiRequest<void>(`/courses/${id}`, { method: "DELETE", token }),
};

export const profileApi = {
  get: (token: string) => apiRequest<ServerProfile>("/me", { token }),
  update: (token: string, changes: ServerProfileUpdate) =>
    apiRequest<ServerProfile>("/me", {
      method: "PATCH",
      token,
      body: JSON.stringify(changes),
    }),
};

export const notesApi = {
  listForCourse: (token: string, courseId: string) =>
    apiRequest<ServerNote[]>(`/notes/course/${courseId}`, { token }),
  sync: (token: string, changes: NoteSyncChange[]) =>
    apiRequest<{ notes: ServerNote[] }>("/notes/sync", {
      method: "POST",
      token,
      body: JSON.stringify({ changes }),
    }),
};
