import type {
  AssetKind,
  ChatAskResponse,
  ChatMessagesResponse,
  ChatQuickAction,
  ChatTranscriptResponse,
  GenerationKind,
  HomeSummary,
  NoteSyncChange,
  ServerAsset,
  ServerAttempt,
  ServerCard,
  ServerCourse,
  ServerCourseCreate,
  ServerDueResponse,
  ServerJob,
  ServerNote,
  ServerProfile,
  ServerProfileUpdate,
  ServerQuiz,
  ServerQuizDetail,
  ServerReviewSyncResponse,
  ServerStudy,
  ServerStudySet,
  SignedUpload,
  SyncResult,
  UploadTask,
} from "./types";

export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api"
).replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(message: string, status = 0, detail = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  rawBody?: BodyInit;
  signal?: AbortSignal;
};

function friendlyDetail(status: number, detail: string) {
  if (status === 401) return "Your session expired. Please sign in again.";
  if (status >= 500) return "Something went wrong on the server. Please try again.";
  if (/prisma|foreign key|constraint|syntax error|database|relation|table/i.test(detail)) {
    return "Unable to complete that request. Please try again.";
  }
  return detail || "Request failed. Please try again.";
}

export async function apiRequest<T>(
  token: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, rawBody, headers, ...rest } = options;
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...rest,
      headers: {
        ...(rawBody ? {} : { "Content-Type": "application/json" }),
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(
      "Could not connect to Sua. Check your internet connection and try again.",
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      const parsed = (await response.json()) as { error?: string };
      detail = parsed.error ?? "";
    } catch {
      detail = "";
    }
    if (response.status === 409 && /sync notes/i.test(detail)) {
      throw new ApiError("This note is still syncing. Please try again in a moment.", 409, detail);
    }
    throw new ApiError(friendlyDetail(response.status, detail), response.status, detail);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const profileApi = {
  get: (token: string) => apiRequest<ServerProfile>(token, "/me"),
  update: (token: string, changes: ServerProfileUpdate) =>
    apiRequest<ServerProfile>(token, "/me", { method: "PATCH", body: changes }),
  deleteAccount: (token: string) =>
    apiRequest<void>(token, "/me/delete", { method: "POST" }),
};

export const coursesApi = {
  list: (token: string) => apiRequest<ServerCourse[]>(token, "/courses"),
  create: (token: string, course: ServerCourseCreate) =>
    apiRequest<ServerCourse>(token, "/courses", { method: "POST", body: course }),
  update: (
    token: string,
    id: string,
    changes: Partial<ServerCourseCreate> & { archived?: boolean },
  ) =>
    apiRequest<ServerCourse>(token, `/courses/${id}`, {
      method: "PATCH",
      body: changes,
    }),
  remove: (token: string, id: string, moveToCourseId?: string) =>
    apiRequest<void>(token, `/courses/${id}`, {
      method: "DELETE",
      body: moveToCourseId ? { moveToCourseId } : undefined,
    }),
};

export const notesApi = {
  get: (token: string, noteId: string) =>
    apiRequest<ServerNote>(token, `/notes/${noteId}`),
  listForCourse: (token: string, courseId: string) =>
    apiRequest<ServerNote[]>(token, `/notes/course/${courseId}`),
  sync: (token: string, changes: NoteSyncChange[]) =>
    apiRequest<{ notes: ServerNote[]; results?: SyncResult[] }>(token, "/notes/sync", {
      method: "POST",
      body: { changes },
    }),
  study: (token: string, noteId: string) =>
    apiRequest<ServerStudy>(token, `/notes/${noteId}/study`),
};

export const uploadsApi = {
  sign: (
    token: string,
    input: {
      kind: AssetKind;
      format: string;
      noteId?: string;
      task?: UploadTask | "none";
      storageProvider: "neon" | "cloudinary";
    },
  ) =>
    apiRequest<SignedUpload>(token, "/uploads/sign", {
      method: "POST",
      body: input,
    }),
  complete: (token: string, id: string, publicId: string) =>
    apiRequest<ServerAsset>(token, `/uploads/${id}/complete`, {
      method: "POST",
      body: { publicId },
    }),
  assetUrl: (token: string, id: string) =>
    apiRequest<{ id: string; url: string; expiresIn: number | null }>(
      token,
      `/assets/${id}/url`,
    ),
  remove: (token: string, id: string) =>
    apiRequest<void>(token, `/assets/${id}`, { method: "DELETE" }),
};

export const jobsApi = {
  enqueue: (token: string, noteId: string, kind: GenerationKind) =>
    apiRequest<ServerJob>(token, "/jobs", { method: "POST", body: { noteId, kind } }),
  get: (token: string, id: string) => apiRequest<ServerJob>(token, `/jobs/${id}`),
  forNote: (token: string, noteId: string) =>
    apiRequest<ServerJob | null>(token, `/jobs/note/${noteId}`),
  feedback: (
    token: string,
    input: {
      targetType: "summary" | "flashcard" | "quiz_question" | "transcript";
      targetId?: string;
      noteId?: string;
      comment: string;
      sourceText?: string;
    },
  ) => apiRequest<{ id: string }>(token, "/jobs/feedback", { method: "POST", body: input }),
};

export type ReviewLogInput = {
  id: string;
  cardId: string;
  grade: "again" | "hard" | "good" | "easy";
  reviewedAt: string;
  prevIntervalDays: number;
};

export type AttemptInput = {
  id: string;
  quizId: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  details: {
    questionId: string;
    answer?: string;
    verdict?: boolean;
  }[];
};

export const studyApi = {
  homeSummary: (token: string) =>
    apiRequest<HomeSummary>(token, "/study/home-summary"),
  sets: (token: string) =>
    apiRequest<{ sets: ServerStudySet[] }>(token, "/study/sets"),
  quiz: (token: string, quizId: string) =>
    apiRequest<ServerQuizDetail>(token, `/study/quizzes/${quizId}`),
  due: (token: string, limit: number, aheadDays = 7) =>
    apiRequest<ServerDueResponse>(
      token,
      `/study/due?limit=${limit}&ahead=${aheadDays}`,
    ),
  syncReviews: (token: string, logs: ReviewLogInput[]) =>
    apiRequest<ServerReviewSyncResponse>(token, "/study/sync/reviews", {
      method: "POST",
      body: { logs },
    }),
  submitAttempt: (token: string, attempt: AttemptInput) =>
    apiRequest<{ attempt: ServerAttempt; job: string | null }>(
      token,
      "/study/attempts",
      { method: "POST", body: attempt },
    ),
  attempt: (token: string, id: string) =>
    apiRequest<ServerAttempt>(token, `/study/attempts/${id}`),
  createCard: (
    token: string,
    noteId: string,
    card: { id: string; front: string; back: string },
  ) =>
    apiRequest<ServerCard>(token, `/study/notes/${noteId}/cards`, {
      method: "POST",
      body: card,
    }),
  updateCard: (
    token: string,
    cardId: string,
    card: { front: string; back: string },
  ) =>
    apiRequest<ServerCard>(token, `/study/cards/${cardId}`, {
      method: "PATCH",
      body: card,
    }),
  deleteCard: (token: string, cardId: string) =>
    apiRequest<{ ok: boolean; id: string }>(token, `/study/cards/${cardId}`, {
      method: "DELETE",
    }),
};

export const chatApi = {
  ask: (
    token: string,
    input: { courseId: string; question: string; quickAction?: ChatQuickAction },
  ) => apiRequest<ChatAskResponse>(token, "/chat/ask", { method: "POST", body: input }),
  messages: (token: string, courseId: string) =>
    apiRequest<ChatMessagesResponse>(
      token,
      `/chat/messages?courseId=${encodeURIComponent(courseId)}`,
    ),
  speech: (token: string, blob: Blob) =>
    apiRequest<ChatTranscriptResponse>(token, "/chat/speech", {
      method: "POST",
      rawBody: blob,
      headers: { "Content-Type": blob.type || "audio/mp4" },
    }),
};

export type { ServerQuiz };
