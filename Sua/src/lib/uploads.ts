import NetInfo, { NetInfoStateType } from "@react-native-community/netinfo";
import { File, UploadType } from "expo-file-system";
import type { SQLiteDatabase } from "expo-sqlite";
import { uploadsApi } from "./api";
import {
  getSetting,
  listPendingUploads,
  listUploadQueue,
  registerUploadCanceller,
  resetUploadProgress,
  setNoteTranscript,
  syncPendingNotes,
  updateUploadProgress,
  updateUploadState,
} from "./notes";
import type { UploadKind, UploadQueueItem } from "./notes";
import { drainGenerationQueue } from "./generate";

// The upload allowlist, mirroring web/lib/uploads.ts and the server's
// ALLOWED_FORMATS (backend/src/routes/uploads.js). Keep the three lists in sync.
export const DOCUMENT_FORMATS = ["pdf", "pptx", "ppt", "txt", "docx", "md"] as const;
export const IMAGE_FORMATS = ["jpg", "jpeg", "png", "webp", "heic", "heif"] as const;
export const AUDIO_FORMATS = ["m4a", "mp3", "wav", "ogg", "aac"] as const;

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function formatBytes(bytes: number) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pick-time gate mirroring the web app's validateFile(): a file outside the
 * allowlist, over the cap, or empty is rejected before a note or a queue row
 * exists, so nothing has to be cleaned up afterwards. Throws the same
 * user-facing copy the web upload panel shows.
 */
export function validateUpload(input: { format: string; size: number; kind: UploadKind }) {
  const format = input.format.toLowerCase().replace(/^\./, "");
  const allowed =
    input.kind === "image"
      ? IMAGE_FORMATS
      : input.kind === "audio"
        ? AUDIO_FORMATS
        : DOCUMENT_FORMATS;
  if (!(allowed as readonly string[]).includes(format)) {
    throw new Error(
      `That file type is not supported. Use ${DOCUMENT_FORMATS.join(", ")} for documents, ${IMAGE_FORMATS.join(", ")} for images, or ${AUDIO_FORMATS.join(", ")} for audio.`,
    );
  }
  if (input.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `That file is ${formatBytes(input.size)}. The limit is 25 MB — try a clearer photo or splitting the document.`,
    );
  }
  if (input.size === 0) throw new Error("That file is empty.");
}

// Map accepted extensions to canonical MIME types for Neon signed PUTs.
const MIME_BY_FORMAT: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
};

function mimeFor(item: UploadQueueItem) {
  return MIME_BY_FORMAT[item.format] ?? "application/octet-stream";
}

interface ActiveUpload {
  noteId: string;
  cancel: () => void;
}

const activeUploads = new Map<number, ActiveUpload>();

export function cancelUploadsForNote(noteId: string): void {
  for (const [id, active] of activeUploads.entries()) {
    if (active.noteId === noteId) {
      try {
        active.cancel();
      } catch {}
      activeUploads.delete(id);
    }
  }
}

registerUploadCanceller(cancelUploadsForNote);

let flushRunning = false;

export type FlushProgress = (item: UploadQueueItem) => void;

// Pushes queued files straight to Neon Object Storage, then the API
// confirms), honouring the Wi-Fi-only preference. Safe to call from anywhere:
// concurrent calls no-op, and any failure leaves the row queued for the next
// connectivity or foreground event. `onProgress` gives a foreground screen
// live updates; background flushes only persist progress to SQLite.
export async function flushUploads(opts: {
  db: SQLiteDatabase;
  getAuthToken: () => Promise<string | null>;
  onProgress?: FlushProgress;
}): Promise<void> {
  if (flushRunning) return;
  flushRunning = true;
  try {
    const { db, getAuthToken } = opts;
    const wifiOnly = (await getSetting(db, "wifi_only")) !== "0";
    const token = await getAuthToken();
    if (!token) return;

    // Rows stuck mid-flight by a crash go back to pending first.
    const initial = await listUploadQueue(db);
    for (const item of initial) {
      if (item.state === "uploading") {
        await updateUploadState(db, item.id, { state: "pending", error: null });
        await resetUploadProgress(db, item.id);
      }
    }

    // Push pending notes to server first so foreign key constraints are satisfied (Rule 9: note sync before uploads)
    await syncPendingNotes(db, token).catch(() => {});

    for (const item of await listPendingUploads(db)) {
      const state = await NetInfo.fetch();
      if (state.isConnected === false) return;
      if (wifiOnly && state.type !== NetInfoStateType.wifi) return;
      // Confirm row and its note still exist before starting upload
      const exists = await db.getFirstAsync<{ id: number }>(
        "SELECT q.id FROM upload_queue q JOIN notes n ON q.note_id = n.id WHERE q.id = ?",
        item.id,
      );
      if (!exists) continue;
      await uploadOne(db, token, item, opts.onProgress);
    }
  } catch {
    // Connectivity or auth hiccup — rows stay queued for the next trigger.
  } finally {
    flushRunning = false;
    // A settled upload can unblock a queued conversion (the drain deliberately
    // waits for it). Fan out fire-and-forget; the drain is serialised per db.
    void drainGenerationQueue({
      db: opts.db,
      getAuthToken: opts.getAuthToken,
    }).catch(() => {});
  }
}

async function uploadOne(
  db: SQLiteDatabase,
  token: string,
  item: UploadQueueItem,
  onProgress?: FlushProgress,
) {
  // Confirm item and its note still exist in SQLite before doing work
  const exists = await db.getFirstAsync<{ id: number }>(
    "SELECT q.id FROM upload_queue q JOIN notes n ON q.note_id = n.id WHERE q.id = ?",
    item.id,
  );
  if (!exists) return;

  const file = new File(item.localPath);
  if (!file.exists) {
    await updateUploadState(db, item.id, {
      state: "failed",
      error: "File no longer exists on this device",
    });
    onProgress?.(item);
    return;
  }

  let isCancelled = false;
  let activeTask: ReturnType<typeof file.createUploadTask> | null = null;
  const cancel = () => {
    isCancelled = true;
    try {
      activeTask?.cancel();
    } catch {}
  };
  activeUploads.set(item.id, { noteId: item.noteId, cancel });

  await updateUploadState(db, item.id, { state: "uploading", error: null });
  await resetUploadProgress(db, item.id);
  let release = () => {};
  const announce = (next: UploadQueueItem) => {
    onProgress?.(next);
  };
  try {
    // The destination chosen in the "What should Sua make?" sheet is carried on
    // the queue row. An explicit choice always converts, whatever the
    // auto-generate preference says; captures with no target send "none".
    let sign;
    try {
      sign = await uploadsApi.sign(token, {
        kind: item.kind,
        format: item.format,
        noteId: item.noteId,
        task: item.target ?? "none",
        storageProvider: "neon",
      });
    } catch {
      // If note has not landed on server yet, sync pending notes and retry signing once
      await syncPendingNotes(db, token).catch(() => {});
      sign = await uploadsApi.sign(token, {
        kind: item.kind,
        format: item.format,
        noteId: item.noteId,
        task: item.target ?? "none",
        storageProvider: "neon",
      });
    }

    if (isCancelled) return;

    const size = file.size ?? 0;
    if (size > sign.maxBytes) {
      const failed: UploadQueueItem = {
        ...item,
        state: "failed",
        progress: 0,
        sentBytes: 0,
        error: `Over the ${Math.round(sign.maxBytes / (1024 * 1024))} MB upload limit`,
      };
      await updateUploadState(db, item.id, failed);
      announce(failed);
      return;
    }
    let lastPersisted = -1;
    const task = file.createUploadTask(sign.uploadUrl, {
      httpMethod: sign.uploadMethod ?? "PUT",
      uploadType: UploadType.BINARY_CONTENT,
      headers: {
        ...(sign.uploadHeaders ?? {}),
        "Content-Length": String(size),
      },
      mimeType: mimeFor(item),
      // Progress ticks stay std-light: persist every ~5% (or the final byte)
      // so a killed app resumes an approximately-placed bar.
      onProgress: ({ bytesSent, totalBytes }) => {
        if (!totalBytes || !size) return;
        const progress = Math.min(100, Math.round((bytesSent / size) * 100));
        if (progress <= lastPersisted) return;
        lastPersisted = progress;
        if (progress % 5 === 0 || bytesSent >= size) {
          void updateUploadProgress(db, item.id, { sentBytes: bytesSent, progress });
          announce({ ...item, state: "uploading", sentBytes: bytesSent, progress });
        }
      },
    });
    activeTask = task;
    release = () => task.release();

    if (isCancelled) return;

    const result = await task.uploadAsync();

    if (isCancelled) return;

    if (result.status < 200 || result.status >= 300) {
      let detail = "";
      try {
        const response = JSON.parse(result.body) as {
          error?: { message?: string };
          message?: string;
        };
        detail = response.error?.message ?? response.message ?? "";
      } catch {
        detail = result.body.slice(0, 200);
      }
      throw new Error(
        `Storage upload failed (${result.status})${detail ? `: ${detail}` : ""}`,
      );
    }

    // Verify parent note was not deleted before finalizing remote asset
    const noteExists = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM notes WHERE id = ?",
      item.noteId,
    );
    if (!noteExists || isCancelled) return;

    const asset = await uploadsApi.complete(token, sign.id, sign.publicId);
    await updateUploadProgress(db, item.id, { sentBytes: size, progress: 100 });
    await updateUploadState(db, item.id, {
      state: "uploaded",
      assetId: asset.id,
      error: null,
    });
    announce({ ...item, state: "uploaded", sentBytes: size, progress: 100 });
    // Documents come back with their extracted text (server-side parsing);
    // mirror it into the local note so it reads without another round trip.
    if (asset.extractedText && item.kind !== "audio") {
      await setNoteTranscript(db, item.noteId, asset.extractedText);
    }
  } catch (error) {
    if (isCancelled) {
      // Cancelled intentionally because the note was deleted; exit silently
      return;
    }
    let message = "Upload failed. Please try again.";
    if (error instanceof Error) {
      const raw = error.message;
      if (/network|offline|connect|internet/i.test(raw)) {
        message = "Waiting for connection";
      } else if (/limit|exceeded|too large|MB/i.test(raw)) {
        message = raw;
      } else if (/storage upload failed/i.test(raw)) {
        message = "Storage upload failed. Please try again.";
      } else if (/sync/i.test(raw)) {
        message = "Syncing note first. Please wait.";
      } else if (!/prisma|sql|constraint|foreign key|500|syntax|database/i.test(raw)) {
        message = raw.length > 80 ? "Upload failed. Please try again." : raw;
      }
    }
    await updateUploadState(db, item.id, {
      state: "failed",
      error: message,
      bumpAttempts: true,
    });
    await resetUploadProgress(db, item.id);
    announce({ ...item, state: "failed", progress: 0, sentBytes: 0, error: message });
  } finally {
    activeUploads.delete(item.id);
    release();
  }
}
