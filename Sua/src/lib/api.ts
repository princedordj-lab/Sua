import type {
  AssetKind,
  GenerationKind,
  NoteSyncChange,
  PushTokenStatus,
  ServerAsset,
  ServerCard,
  ServerFeedback,
  ServerAttempt,
  ServerJob,
  ServerNote,
  ServerCourse,
  ServerCourseCreate,
  ServerProfile,
  ServerProfileUpdate,
  ServerReviewSyncResponse,
  ServerStudy,
  ServerTombstonePage,
  SignedUpload,
  SyncResult,
  UploadTask,
} from "./types";
import { Platform } from "react-native";

const API_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  (Platform.OS === "android" ? "http://10.0.2.2:4000/api" : "http://localhost:4000/api");
type RequestOptions = RequestInit & { token?: string; timeoutMs?: number };

// Every request gets a ceiling. Without one, a half-open connection leaves the
// fetch pending forever; the note-sync pass is serialised per database, so one
// stuck request would block every later sync and leave notes "Waiting to sync".
const REQUEST_TIMEOUT_MS = 30_000;

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
) {
  // `timeoutMs` is a Sua-only option, so it never reaches fetch's RequestInit.
  const { token, timeoutMs = REQUEST_TIMEOUT_MS, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: init.signal ?? controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new Error("Could not connect to Sua. Check your internet connection.");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.text();
      const parsed = JSON.parse(body) as { error?: string };
      detail = parsed.error ?? "";
    } catch {
      detail = "";
    }

    // Callers such as the generation queue need to tell "this note is gone"
    // (404) apart from a transient failure without parsing the message.
    const fail = (message: string) =>
      Object.assign(new Error(message), { status: response.status });

    if (response.status >= 500) {
      throw fail("Something went wrong on the server. Please try again.");
    }

    if (
      /prisma|foreign key|constraint|syntax error|database|relation|table/i.test(
        detail,
      )
    ) {
      throw fail("Unable to complete request. Please try again.");
    }

    if (response.status === 409 && /sync notes/i.test(detail)) {
      throw fail("Note is syncing with the server. Please wait a moment.");
    }

    throw fail(detail || "Request failed. Please try again.");
  }
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
  remove: (token: string, id: string, moveToCourseId?: string) =>
    apiRequest<void>(`/courses/${id}`, {
      method: "DELETE",
      token,
      body: moveToCourseId ? JSON.stringify({ moveToCourseId }) : undefined,
    }),
};

export const profileApi = {
  get: (token: string) => apiRequest<ServerProfile>("/me", { token }),
  update: (token: string, changes: ServerProfileUpdate) =>
    apiRequest<ServerProfile>("/me", {
      method: "PATCH",
      token,
      body: JSON.stringify(changes),
    }),
  deletePushToken: (token: string, expoToken: string) =>
    apiRequest<void>("/me/push-token", {
      method: "DELETE",
      token,
      body: JSON.stringify({ token: expoToken }),
    }),
  deleteAccount: (token: string) =>
    apiRequest<void>("/me/delete", { method: "POST", token }),
};

export const notesApi = {
  listForCourse: (token: string, courseId: string) =>
    apiRequest<ServerNote[]>(`/notes/course/${courseId}`, { token }),
  sync: (token: string, changes: NoteSyncChange[]) =>
    apiRequest<{ notes: ServerNote[]; results?: SyncResult[] }>("/notes/sync", {
      method: "POST",
      token,
      body: JSON.stringify({ changes }),
    }),
  tombstones: (
    token: string,
    options: { since?: string; after?: string; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.since) params.set("since", options.since);
    if (options.after) params.set("after", options.after);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return apiRequest<ServerTombstonePage>(
      `/notes/tombstones${query ? `?${query}` : ""}`,
      { token },
    );
  },
};

export const uploadsApi = {
  sign: (token: string, input: { kind: AssetKind; format: string; noteId?: string; task?: UploadTask | "none"; storageProvider?: "neon" }) =>
    apiRequest<SignedUpload>("/uploads/sign", {
      method: "POST",
      token,
      body: JSON.stringify(input),
    }),
  complete: (token: string, id: string, publicId: string) =>
    apiRequest<ServerAsset>(`/uploads/${id}/complete`, {
      method: "POST",
      token,
      body: JSON.stringify({ publicId }),
    }),
};

export const assetsApi = {
  signedUrl: (token: string, id: string) =>
    apiRequest<{ id: string; url: string }>(`/assets/${id}/url`, { token }),
  remove: (token: string, id: string) =>
    apiRequest<void>(`/assets/${id}`, { method: "DELETE", token }),
};

export const jobsApi = {
  create: (token: string, noteId: string, kind?: GenerationKind) =>
    apiRequest<ServerJob | null>("/jobs", {
      method: "POST",
      token,
      body: JSON.stringify({ noteId, kind }),
    }),
  get: (token: string, id: string) => apiRequest<ServerJob>(`/jobs/${id}`, { token }),
  latestForNote: (token: string, noteId: string) =>
    apiRequest<ServerJob | null>(`/jobs/note/${noteId}`, { token }),
  feedback: (
    token: string,
    input: {
      targetType: "summary" | "flashcard" | "quiz_question" | "transcript";
      targetId?: string;
      noteId?: string;
      comment: string;
      sourceText?: string;
    },
  ) =>
    apiRequest<ServerFeedback>("/jobs/feedback", {
      method: "POST",
      token,
      body: JSON.stringify(input),
    }),
};

export const studyApi = {
  forNote: (token: string, noteId: string) =>
    apiRequest<ServerStudy>(`/notes/${noteId}/study`, { token }),
  postReviews: (token: string, logs: { id: string; cardId: string; grade: string; reviewedAt: string; prevIntervalDays: number; newIntervalDays: number }[]) =>
    apiRequest<ServerReviewSyncResponse>("/study/sync/reviews", {
      method: "POST",
      token,
      body: JSON.stringify({ logs }),
    }),
  postAttempts: (token: string, attempts: unknown[]) =>
    apiRequest<{ ok: boolean }>("/study/sync/quiz-attempts", {
      method: "POST",
      token,
      body: JSON.stringify({ attempts }),
    }),
  submitAttempt: (
    token: string,
    input: {
      id: string;
      quizId: string;
      total: number;
      startedAt: string;
      finishedAt: string;
      details: { questionId: string; answer?: string; verdict?: boolean | null }[];
    },
  ) =>
    apiRequest<{ attempt: ServerAttempt; job: string | null }>("/study/attempts", {
      method: "POST",
      token,
      body: JSON.stringify(input),
    }),
  getAttempt: (token: string, id: string) =>
    apiRequest<ServerAttempt>(`/study/attempts/${id}`, { token }),
  createCard: (token: string, noteId: string, input: { id: string; front: string; back: string }) =>
    apiRequest<ServerCard>(`/study/notes/${noteId}/cards`, {
      method: "POST",
      token,
      body: JSON.stringify(input),
    }),
  updateCard: (token: string, cardId: string, input: { front: string; back: string }) =>
    apiRequest<ServerCard>(`/study/cards/${cardId}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(input),
    }),
  deleteCard: (token: string, cardId: string) =>
    apiRequest<{ ok: boolean }>(`/study/cards/${cardId}`, { method: "DELETE", token }),
};

export const pushApi = {
  registerToken: (token: string, expoPushToken: string) =>
    apiRequest<PushTokenStatus>("/me/push-token", {
      method: "POST",
      token,
      body: JSON.stringify({ token: expoPushToken }),
    }),
};
