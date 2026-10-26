import type { ApiClient } from "./use-api";
import type { AssetKind, GenerationKind, ServerAsset, ServerJob, UploadTask } from "./types";

export const DOCUMENT_FORMATS = ["pdf", "pptx", "ppt", "txt", "docx"] as const;
export const IMAGE_FORMATS = ["jpg", "jpeg", "png", "webp", "heic", "heif"] as const;
export const AUDIO_FORMATS = ["m4a", "mp3", "wav", "ogg", "aac"] as const;

export const ACCEPT_DOCUMENTS = ".pdf,.pptx,.ppt,.txt,.docx,application/pdf";
export const ACCEPT_IMAGES = ".jpg,.jpeg,.png,.webp,.heic,.heif,image/*";
export const ACCEPT_AUDIO = ".m4a,.mp3,.wav,.ogg,.aac,audio/*";
export const ACCEPT_ALL = `${ACCEPT_DOCUMENTS},${ACCEPT_IMAGES},${ACCEPT_AUDIO}`;

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

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

export function extensionOf(name: string) {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
}

export function mimeFor(format: string) {
  return MIME_BY_FORMAT[format.toLowerCase()] ?? "application/octet-stream";
}

export function kindForFormat(format: string): AssetKind | null {
  const normalized = format.toLowerCase();
  if ((DOCUMENT_FORMATS as readonly string[]).includes(normalized)) return "document";
  if ((IMAGE_FORMATS as readonly string[]).includes(normalized)) return "image";
  if ((AUDIO_FORMATS as readonly string[]).includes(normalized)) return "audio";
  return null;
}

export function validateFile(file: File): { format: string; kind: AssetKind } {
  const format = extensionOf(file.name);
  const kind = kindForFormat(format);
  if (!kind) {
    throw new Error(
      `That file type is not supported. Use ${DOCUMENT_FORMATS.join(", ")} for documents, ${IMAGE_FORMATS.join(", ")} for images, or ${AUDIO_FORMATS.join(", ")} for audio.`,
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `That file is ${formatBytes(file.size)}. The limit is 25 MB — try compressing it or splitting the document.`,
    );
  }
  if (file.size === 0) throw new Error("That file is empty.");
  return { format, kind };
}

export function formatBytes(bytes: number) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uploadToUrl(
  url: string,
  file: Blob | FormData,
  method: "PUT" | "POST",
  headers: Record<string, string>,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "authorization") continue;
      xhr.setRequestHeader(key, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status}). Check your connection and try again.`));
      }
    };
    xhr.onerror = () =>
      reject(new Error("Could not reach storage. Check your connection and try again."));
    xhr.ontimeout = () => reject(new Error("The upload timed out. Please try again."));
    xhr.timeout = 10 * 60_000;
    xhr.send(file);
  });
}

/**
 * sign -> direct upload -> complete. Media never passes through the API; it
 * gets a short-lived presigned URL (Neon) or the legacy Cloudinary signature.
 */
export async function uploadFile(
  api: ApiClient,
  file: File | Blob,
  input: {
    format: string;
    kind: AssetKind;
    noteId: string;
    task?: UploadTask | "none";
    onProgress?: (percent: number) => void;
    fileName?: string;
  },
): Promise<ServerAsset> {
  const format = input.format.toLowerCase();
  const signed = await api.uploads.sign({
    kind: input.kind,
    format,
    noteId: input.noteId,
    task: input.task ?? "none",
    storageProvider: "neon",
  });

  const progress = input.onProgress ?? (() => {});
  progress(1);

  if (signed.uploadMethod === "PUT") {
    await uploadToUrl(
      signed.uploadUrl,
      file,
      "PUT",
      {
        "Content-Type": mimeFor(format),
        ...(signed.uploadHeaders ?? {}),
      },
      progress,
    );
  } else {
    // Legacy Cloudinary multipart (the compatibility path until its migration
    // window closes). The signature is created server-side and never stored.
    const form = new FormData();
    form.append("file", file, input.fileName ?? `upload.${format}`);
    form.append("api_key", signed.apiKey ?? "");
    form.append("timestamp", String(signed.timestamp ?? ""));
    form.append("signature", signed.signature ?? "");
    form.append("public_id", signed.publicId);
    form.append("type", "authenticated");
    await uploadToUrl(
      signed.uploadUrl,
      form,
      "POST",
      signed.uploadHeaders ?? {},
      progress,
    );
  }

  return api.uploads.complete(signed.id, signed.publicId);
}

export async function waitForJob(
  api: ApiClient,
  noteId: string,
  options: {
    onJob?: (job: ServerJob | null) => void;
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<ServerJob | null> {
  const timeout = options.timeoutMs ?? 12 * 60_000;
  const interval = options.intervalMs ?? 4000;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const job = await api.jobs.forNote(noteId);
    options.onJob?.(job);
    if (!job || job.state === "done" || job.state === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return null;
}

export function generationKindFor(task: UploadTask | "none"): GenerationKind {
  return task === "course_reference" ? "course_reference" : "lecture_note";
}
