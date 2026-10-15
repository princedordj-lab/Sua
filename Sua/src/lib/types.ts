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

export type ServerNote = {
  id: string;
  courseId: string;
  title: string;
  body: string;
  sourceType: "typed" | "audio" | "file";
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
