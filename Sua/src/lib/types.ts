export type Course = {
  id: string;
  code: string;
  name: string;
  lecturer: string;
  color: string;
  examDate?: string | null;
  noteCount: number;
  archived?: boolean;
};

export type UserProfile = {
  name: string;
  email: string;
  university: string;
  programme: string;
  level: string;
  examDate?: string;
  plan?: string;
  planExpiresAt?: string | null;
};

export type ServerCourse = {
  id: string;
  name: string;
  code: string | null;
  examDate: string | null;
  colour: string;
  lecturer: string | null;
  archived: boolean;
};

export type ServerCourseCreate = {
  name: string;
  code?: string | null;
  examDate?: string | null;
  colour?: string;
  lecturer?: string | null;
};

export type ServerProfile = {
  id: string;
  name: string | null;
  email: string;
  university: string | null;
  programme: string | null;
  level: string | null;
  plan: string;
  planExpiresAt: string | null;
  onboardingCompletedAt: string | null;
};

export type ServerProfileUpdate = {
  name?: string | null;
  university?: string | null;
  programme?: string | null;
  level?: string | null;
  onboardingCompleted?: boolean;
};

// Settings stored in the device settings KV table. Keys that gate behaviour
// ship "on" when the row is missing.
export type SettingKey =
  | "wifi_only"
  | "auto_generate"
  | "review_reminder_enabled"
  | "review_reminder_time"
  | "push_enabled"
  | "expo_push_token";

export type AiState =
  | "none"
  | "queued"
  | "reading"
  | "reading_scans"
  | "digesting"
  | "writing"
  | "checking"
  | "summarising"
  | "making_cards"
  | "ready"
  | "failed";

// Diagnostics the server stores on the job for a finished generation. Optional
// everywhere: older jobs and offline notes have none.
export type JobMeta = {
  promptVersion?: string;
  sourceType?: "file" | "recording" | "typed" | null;
  truncated?: boolean;
  pagesUsed?: number;
  pageCount?: number;
  minutes?: number;
  digests?: number;
  words?: number;
  checkPassed?: boolean | null;
  unsupportedNumbers?: string[];
  unsupportedFormulas?: string[];
  modelCalls?: number;
};

export type NoteKind = "note" | "reference";

// Destination the student picked for a document/photo upload.
export type UploadTask = "lecture_note" | "course_reference";

// What a generation job should produce (server job `kind`).
// - study_set: summary + flashcards + quiz; the note body is never rewritten.
// - lecture_note: an AI-written note body, then summary + flashcards + quiz.
// - course_reference: the condensed reference sheet (no cards or quiz).
export type GenerationKind = "study_set" | "lecture_note" | "course_reference";

export type ServerNote = {
  id: string;
  courseId: string;
  title: string;
  body: string;
  sourceType: "typed" | "audio" | "file";
  aiState?: AiState;
  transcript?: string | null;
  summary?: string | null;
  noteKind?: NoteKind;
  createdAt: string;
  updatedAt: string;
};

export type NoteSyncChange = {
  operation: "upsert" | "delete";
  id: string;
  courseId?: string;
  title?: string;
  body?: string;
  sourceType?: "typed" | "audio" | "file";
  noteKind?: NoteKind;
  updatedAt?: string;
};

export type SyncResultStatus = "accepted" | "rejected" | "conflict" | "deleted";

// Per-change acknowledgement from POST /notes/sync. A conflict carries the
// newer server copy so the device can adopt it instead of retrying forever.
export type SyncResult = {
  id: string;
  status: SyncResultStatus;
  reason?: string;
  note?: ServerNote;
};

export type AssetKind = "audio" | "document" | "image";

export type ServerAsset = {
  id: string;
  kind: AssetKind;
  publicId: string;
  storageProvider?: "neon" | "cloudinary";
  secureUrl: string | null;
  bytes: number;
  format: string | null;
  resourceType: string;
  status: "pending" | "active";
  noteId: string | null;
  task?: UploadTask | "none";
  extractedText?: string | null;
  // Background reading state (migration 16 on the backend).
  extractState?: ExtractState;
  extractedPages?: number;
  totalPages?: number;
  extractErrorCode?: string | null;
  extractTruncated?: boolean;
  createdAt: string;
};

export type ExtractState = import("./notes").ExtractState;

export type SignedUpload = ServerAsset & {
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  uploadMethod?: "PUT" | "POST";
  uploadExpiresAt?: string | null;
  apiKey?: string;
  cloudName?: string;
  timestamp?: number;
  signature?: string;
  type?: "authenticated";
  maxBytes: number;
};

export type Note = import("./notes").Note;

export type ServerJob = {
  id: string;
  noteId: string;
  kind: string;
  state: "queued" | "running" | "done" | "failed";
  stage: AiState;
  attempts: number;
  error: string | null;
  // Generation diagnostics (pages read, truncation, fidelity check).
  meta?: JobMeta | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type ServerQuizQuestion = {
  id: string;
  quizId: string;
  ordinal: number;
  type: "mcq" | "true_false" | "short_answer";
  prompt: string;
  options: string[] | null;
  answer: string;
  explanation: string;
};

export type ServerQuiz = {
  id: string;
  noteId: string;
  title: string;
  questions: ServerQuizQuestion[];
};

// GET /api/notes/:noteId/study — everything generated for one note.
export type ServerStudy = {
  summaryMarkdown: string;
  flashcards: {
    id: string;
    front: string;
    back: string;
    dueAt?: string;
    ease?: number;
    intervalDays?: number;
    reps?: number;
  }[];
  quizzes: ServerQuiz[];
};

// POST /api/study/sync/reviews — refreshed scheduling for replayed cards.
export type ServerCardScheduling = {
  id: string;
  dueAt: string;
  ease: number;
  intervalDays: number;
  reps: number;
};

export type ServerReviewSyncResponse = { cards: Record<string, ServerCardScheduling> | null };

export type ServerAttemptDetails = {
  questionId: string;
  answer?: string;
  verdict?: boolean;
  partial?: boolean;
  comment?: string;
};

// POST /api/study/attempts + GET /api/study/attempts/:id
export type ServerAttempt = {
  id: string;
  state: string;
  correct: number;
  total: number;
  details: ServerAttemptDetails[] | null;
  error?: string | null;
};

export type ServerCard = {
  id: string;
  noteId: string;
  front: string;
  back: string;
  dueAt: string;
  ease: number;
  intervalDays: number;
  reps: number;
};

export type ServerFeedback = { id: string };

export type PushTokenStatus = { ok: boolean };

export type ChatRole = "user" | "assistant";

export type ChatQuickAction = "explain_simply" | "give_example" | "quiz_me";

export type ChatMessageView = {
  id: string;
  courseId: string;
  role: ChatRole;
  content: string;
  sourceNoteIds: string[];
  createdAt: string;
};

export type ChatAskResponse = {
  user: ChatMessageView;
  assistant: ChatMessageView;
  sources: { id: string; title: string }[];
  model?: string;
};

export type ChatMessagesResponse = { messages: ChatMessageView[] };

export type ChatTranscriptResponse = { text: string };
