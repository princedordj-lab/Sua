import NetInfo, { NetInfoStateType } from "@react-native-community/netinfo";
import { File, UploadType } from "expo-file-system";
import type { SQLiteDatabase } from "expo-sqlite";
import { uploadsApi } from "./api";
import { getSetting, listUploadQueue, setNoteTranscript, updateUploadState } from "./notes";
import type { UploadQueueItem } from "./notes";

// Cloudinary is strict about MIME types on raw/image uploads; map the
// extensions we accept to their canonical types.
const MIME_BY_FORMAT: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
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

let flushRunning = false;

// Pushes queued files straight to storage (client → Cloudinary, then the API
// confirms), honouring the Wi-Fi-only preference. Safe to call from anywhere:
// concurrent calls no-op, and any failure leaves the row queued for the next
// connectivity or foreground event.
export async function flushUploads(opts: {
  db: SQLiteDatabase;
  getAuthToken: () => Promise<string | null>;
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
      }
    }

    for (const item of await listUploadQueue(db)) {
      const state = await NetInfo.fetch();
      if (state.isConnected === false) return;
      if (wifiOnly && state.type !== NetInfoStateType.wifi) return;
      await uploadOne(db, token, item);
    }
  } catch {
    // Connectivity or auth hiccup — rows stay queued for the next trigger.
  } finally {
    flushRunning = false;
  }
}

async function uploadOne(db: SQLiteDatabase, token: string, item: UploadQueueItem) {
  const file = new File(item.localPath);
  if (!file.exists) {
    await updateUploadState(db, item.id, {
      state: "failed",
      error: "File no longer exists on this device",
    });
    return;
  }
  await updateUploadState(db, item.id, { state: "uploading", error: null });
  let release = () => {};
  try {
    const sign = await uploadsApi.sign(token, {
      kind: item.kind,
      format: item.format,
      noteId: item.noteId,
    });
    const size = file.size ?? 0;
    if (size > sign.maxBytes) {
      await updateUploadState(db, item.id, {
        state: "failed",
        error: `Over the ${Math.round(sign.maxBytes / (1024 * 1024))} MB upload limit`,
      });
      return;
    }
    const task = file.createUploadTask(sign.uploadUrl, {
      httpMethod: "POST",
      uploadType: UploadType.MULTIPART,
      fieldName: "file",
      mimeType: mimeFor(item),
      parameters: {
        api_key: sign.apiKey,
        timestamp: String(sign.timestamp),
        signature: sign.signature,
        public_id: sign.publicId,
        type: sign.type,
      },
    });
    release = () => task.release();
    const result = await task.uploadAsync();
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Storage upload failed (${result.status})`);
    }
    const asset = await uploadsApi.complete(token, sign.id, sign.publicId);
    await updateUploadState(db, item.id, {
      state: "uploaded",
      assetId: asset.id,
      error: null,
    });
    // Documents come back with their extracted text (server-side parsing);
    // mirror it into the local note so it reads without another round trip.
    if (asset.extractedText && item.kind !== "audio") {
      await setNoteTranscript(db, item.noteId, asset.extractedText);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    await updateUploadState(db, item.id, {
      state: "failed",
      error: message,
      bumpAttempts: true,
    });
  } finally {
    release();
  }
}
