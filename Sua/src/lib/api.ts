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
import Constants from "expo-constants";
import { Platform } from "react-native";

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(?=[:/]|$)/;
// Only a machine's own private LAN address may replace a loopback dev URL. A
// Metro tunnel host (xxx.exp.direct) must not be borrowed: the tunnel forwards
// Metro's port only, so pointing the API at it would hang every request.
const LAN_HOST = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/;

/**
 * Resolve the API base URL.
 *
 * `localhost` is only the host machine on the iOS simulator, the web build, or
 * through `adb reverse`. On a physical phone it is the phone itself, so a dev
 * URL of `http://localhost:4000/api` silently refuses every request. Metro
 * knows the machine's LAN address (`hostUri`), so a loopback dev URL is
 * rewritten to it when that address is genuinely a LAN address. Anything that
 * is not a loopback host, and every release build, is used exactly as
 * configured.
 */
function resolveApiUrl() {
  const configured =
    process.env.EXPO_PUBLIC_API_URL ??
    (Platform.OS === "android"
      ? "http://10.0.2.2:4000/api"
      : "http://localhost:4000/api");
  if (!__DEV__ || !LOOPBACK.test(configured)) return configured;
  const host = (Constants.expoConfig?.hostUri ?? "").split(":")[0];
  if (host && LAN_HOST.test(host)) {
    return configured.replace(LOOPBACK, `http://${host}`);
  }
  // Metro is reached through adb reverse, a simulator, or a tunnel: nothing to
  // borrow. Keep the configured URL; the failure message names it verbatim.
  return configured;
}

const API_URL = resolveApiUrl();

// Exposed so a hydration failure can name the host it tried in dev: "could not
// reach the server" is unactionable without knowing which URL was used.
export const API_BASE_URL = API_URL;
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
    // "Check your internet connection" is the wrong advice for both of these:
    // a timeout means the server is slow, and a rejected connection usually
    // means the app is pointed at a host it cannot see (localhost on a phone).
    // Naming the URL in dev turns a mystery into a one-line fix.
    if (controller.signal.aborted && !init.signal) {
      throw new Error(
        __DEV__
          ? `Sua took too long to answer (${API_URL}).`
          : "Sua took too long to answer. Please try again.",
      );
    }
    throw new Error(
      __DEV__
        ? `Could not reach Sua at ${API_URL}.`
        : "Could not connect to Sua. Check your internet connection.",
    );
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

    if (response.status === 401) {
      // The token reached the API but did not verify. The usual cause is the
      // app and the API pointing at different Clerk instances (a `pk_live_`
      // app against a `pk_test_` backend), which no amount of retrying fixes.
      if (__DEV__) {
        console.warn(
          "[api] 401 from " +
            path +
            ": the API rejected this session token. Check that backend CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY and EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY all belong to the same Clerk instance.",
        );
      }
      throw fail("Sua could not confirm your session. Sign out and sign in again.");
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

    // The API answers ACCOUNT_CONFLICT with the code in `error` and the readable
    // sentence in `message`; surface the sentence instead of the raw code.
    if (response.status === 409 && detail === "ACCOUNT_CONFLICT") {
      throw fail(
        "This email is already linked to another Sua account. Sign in with that account instead.",
      );
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
  // Deliberately the default 30s ceiling: this is the first call of a session
  // and a cold API/Neon start legitimately takes ~10s. A shorter timeout here
  // reported "offline" for a request that was about to succeed.
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

export type ActivityResponse = {
  streakDays: number;
  activeToday: boolean;
  lastActiveDay: string | null;
  timezone: string;
};

// App-open streak: the server owns the count; the device only reports days.
export const streakApi = {
  record: (
    token: string,
    payload: { days: string[]; timezone: string; utcOffsetMinutes?: number },
  ) =>
    apiRequest<ActivityResponse>("/me/activity", {
      method: "POST",
      token,
      timeoutMs: 15_000,
      body: JSON.stringify(payload),
    }),
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
  registerToken: (token: string, expoPushToken: string, platform: "ios" | "android") =>
    apiRequest<PushTokenStatus>("/me/push-token", {
      method: "POST",
      token,
      body: JSON.stringify({ token: expoPushToken, platform }),
    }),
  test: (token: string) =>
    apiRequest<{ ok: boolean }>("/me/push-test", {
      method: "POST",
      token,
      body: JSON.stringify({ transport: "mobile" }),
    }),
};
