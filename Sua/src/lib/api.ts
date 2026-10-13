import type { Course, UserProfile } from "./types";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000/api";
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
  return response.json() as Promise<T>;
}

export const coursesApi = {
  list: (token: string) => apiRequest<Course[]>("/courses", { token }),
  create: (token: string, course: Omit<Course, "id">) =>
    apiRequest<Course>("/courses", {
      method: "POST",
      token,
      body: JSON.stringify(course),
    }),
  update: (token: string, id: string, changes: Partial<Course>) =>
    apiRequest<Course>(`/courses/${id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(changes),
    }),
  remove: (token: string, id: string) =>
    apiRequest<void>(`/courses/${id}`, { method: "DELETE", token }),
};

export const profileApi = {
  update: (token: string, profile: Partial<UserProfile>) =>
    apiRequest<UserProfile>("/me", {
      method: "PATCH",
      token,
      body: JSON.stringify(profile),
    }),
};
