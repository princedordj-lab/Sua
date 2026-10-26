// Mirrors Sua/src/lib/types.ts where the web shares the same backend contract.
// Mobile-only shapes (SQLite rows, push tokens) are deliberately omitted.

export type AppearancePref = "system" | "light" | "dark";
export type NoteTextScale = "small" | "medium" | "large";

export type ServerCourse = {
  id: string;
  name: string;
  code: string | null;
  examDate: string | null;
  colour: string;
  lecturer: string | null;
  archived: boolean;
  noteCount: number;
};

export type ServerCourseCreate = {
  name: string;
  code?: string | null;
  examDate?: string | null;
  colour?: string;
  lecturer?: string | null;
};

export type UsageLimits = {
  summaries: number;
  studySets: number;
  references: number;
  assistantQueries: number;
};

export type Usage = {
  month: string;
  summaries: number;
  studySets: number;
  references: number;
  assistantQueries: number;
  limits: UsageLimits;
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
  usage: Usage;
};

export type ServerProfileUpdate = {
  name?: string | null;
  university?: string | null;
  programme?: string | null;
  level?: string | null;
  onboardingCompleted?: boolean;
};

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
  | "failed"
  | "marking";

export type NoteKind = "note" | "reference";
export type SourceType = "typed" | "audio" | "file";
export type UploadTask = "lecture_note" | "course_reference";
export type GenerationKind = "study_set" | "lecture_note" | "course_reference";

export type ServerNote = {
  id: string;
  courseId: string;
  title: string;
  body: string;
  sourceType: SourceType;
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
  sourceType?: SourceType;
  noteKind?: NoteKind;
  updatedAt?: string;
};

export type SyncResultStatus = "accepted" | "rejected" | "conflict" | "deleted";

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
  createdAt: string;
};

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

export type JobMeta = {
  promptVersion?: string;
  sourceType?: SourceType | null;
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

export type ServerJob = {
  id: string;
  noteId: string;
  kind: string;
  state: "queued" | "running" | "done" | "failed";
  stage: AiState;
  attempts: number;
  error: string | null;
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

export type ServerQuizDetail = ServerQuiz & {
  noteTitle: string;
  courseId: string | null;
};

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

export type ServerCardScheduling = {
  id: string;
  dueAt: string;
  ease: number;
  intervalDays: number;
  reps: number;
};

export type ServerReviewSyncResponse = {
  cards: Record<string, ServerCardScheduling> | null;
};

export type ServerAttemptDetails = {
  questionId: string;
  answer?: string;
  verdict?: boolean | null;
  partial?: boolean;
  comment?: string;
};

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

export type ServerDueCard = ServerCard & {
  courseId: string;
  noteTitle: string;
};

/** `GET /api/study/due` — `aheadCards` are the review-ahead fallback. */
export type ServerDueResponse = {
  due: number;
  aheadDays: number;
  cards: ServerDueCard[];
  aheadCards: ServerDueCard[];
};

export type ServerStudySet = {
  noteId: string;
  noteTitle: string;
  courseId: string;
  cards: number;
  quizzes: number;
  updatedAt: string;
};

export type HomeSummary = {
  due: number;
  totalCards: number;
  reviewedToday: number;
  quizAttemptsToday: number;
  streakDays: number;
  weekly: { date: string; reviewed: number }[];
};

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

export type CardGrade = "again" | "hard" | "good" | "easy";
