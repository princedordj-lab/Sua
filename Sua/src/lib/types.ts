export type Course = {
  id: string;
  code: string;
  name: string;
  lecturer: string;
  color: string;
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
};

export type ServerCourse = {
  id: string;
  name: string;
  code: string | null;
  examDate: string | null;
  colour: string;
  archived: boolean;
};

export type ServerCourseCreate = {
  name: string;
  code?: string | null;
  examDate?: string | null;
  colour?: string;
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

export type AiState =
  | "none"
  | "queued"
  | "transcribing"
  | "summarising"
  | "making_cards"
  | "ready"
  | "failed";

export type ServerNote = {
  id: string;
  courseId: string;
  title: string;
  body: string;
  sourceType: "typed" | "audio" | "file";
  aiState?: AiState;
  transcript?: string | null;
  summary?: string | null;
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
  updatedAt?: string;
};

export type SyncResultStatus = "accepted" | "rejected" | "conflict";

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
  secureUrl: string | null;
  bytes: number;
  format: string | null;
  resourceType: string;
  status: "pending" | "active";
  noteId: string | null;
  extractedText?: string | null;
  createdAt: string;
};

export type SignedUpload = ServerAsset & {
  uploadUrl: string;
  apiKey: string;
  cloudName: string;
  timestamp: number;
  signature: string;
  type: "restricted";
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
  flashcards: { id: string; front: string; back: string }[];
  quizzes: ServerQuiz[];
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
