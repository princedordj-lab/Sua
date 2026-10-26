import { Router } from "express";
import { cloudinary, cloudinaryConfigured } from "../config/cloudinary.js";
import { neonStorageConfigured, presignNeonObject } from "../config/neon-storage.js";
import { assetDownloadUrl, deleteAssetObject, readAssetBytes, storageProviderOf, verifyNeonObject } from "../lib/storage.js";
import { withUser } from "../lib/db.js";
import { extractDocumentText } from "../lib/extract.js";
import { maybeEnqueueGeneration } from "../lib/pipeline.js";
import { requireUser } from "../lib/users.js";
import { identityFromRequest } from "../lib/identity.js";

export const uploadsRouter = Router();
export const assetsRouter = Router();

function mimeForFormat(format, kind) {
  const mimeByFormat = {
    pdf: "application/pdf", txt: "text/plain; charset=utf-8",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ppt: "application/vnd.ms-powerpoint",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    heic: "image/heic", heif: "image/heif", m4a: "audio/mp4", mp3: "audio/mpeg",
    wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac",
  };
  return mimeByFormat[format] ?? (kind === "image" ? "image/jpeg" : "application/octet-stream");
}

const MAX_BYTES = {
  document: 25 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  // 60-minute Pro recordings at the ~0.5 MB/min compression target.
  audio: 50 * 1024 * 1024,
};

// Where the student wants a document/photo converted once it lands.
const TASKS = new Set(["lecture_note", "course_reference"]);

// Upper bound for files we attempt to parse on upload-complete.
const MAX_EXTRACT_BYTES = 25 * 1024 * 1024;

const ALLOWED_FORMATS = {
  document: ["pdf", "pptx", "ppt", "txt", "docx"],
  image: ["jpg", "jpeg", "png", "webp", "heic", "heif"],
  audio: ["m4a", "mp3", "wav", "ogg", "aac"],
};

// Cloudinary stores audio under the "video" resource type.
const RESOURCE_TYPES = {
  document: "raw",
  image: "image",
  audio: "video",
};

function shapeAsset(asset) {
  return {
    id: asset.id,
    kind: asset.kind,
    publicId: asset.publicId,
    storageProvider: storageProviderOf(asset),
    secureUrl: asset.secureUrl,
    bytes: asset.bytes,
    format: asset.format,
    resourceType: asset.resourceType,
    status: asset.status,
    noteId: asset.noteId,
    task: asset.task ?? "none",
    extractedText: asset.extractedText ?? null,
    createdAt: asset.createdAt,
  };
}

// Downloads the confirmed bytes through a signed URL (the media itself never
// travels through the API) and parses any text the format supports.
async function extractFromStorage(asset) {
  const buffer = await readAssetBytes(asset);
  return extractDocumentText(buffer, asset.format, asset.kind);
}

// Cloudinary's Admin API index can lag behind a direct upload by a few
// seconds. Retry on transient 404s so a race between upload completion and
// indexing doesn't surface as a permanent user-visible error.
async function fetchRemoteWithRetry(publicId, resourceType, maxAttempts = 3, baseDelayMs = 500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await cloudinary.api.resource(publicId, {
        resource_type: resourceType,
        type: "authenticated",
      });
    } catch (err) {
      const isNotFound =
        err?.http_code === 404 ||
        /not found/i.test(err?.message ?? "");
      if (!isNotFound || attempt === maxAttempts) throw err;
      // Transient indexing lag — wait then retry with exponential back-off.
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

// Older clients omit storageProvider and keep using Cloudinary while the app
// rollout drains queued transfers. Current clients request Neon presigned PUTs.
uploadsRouter.post("/sign", async (req, res) => {
  const identity = await identityFromRequest(req);
  // New app versions identify Neon explicitly. Older installed builds omit
  // this field and continue to receive the legacy Cloudinary multipart shape.
  const storageProvider = req.body?.storageProvider === "neon" ? "neon" : "cloudinary";
  if (storageProvider === "neon" && !neonStorageConfigured()) {
    return res.status(503).json({ error: "Neon Object Storage is not configured" });
  }
  if (storageProvider === "cloudinary" && !cloudinaryConfigured()) {
    return res.status(503).json({ error: "Legacy upload storage is not configured" });
  }
  const { kind, format } = req.body ?? {};
  if (!kind || !(kind in MAX_BYTES)) {
    return res.status(400).json({ error: "kind must be audio, document, or image" });
  }
  const normalizedFormat = String(format ?? "").toLowerCase().replace(/^\./, "");
  if (!ALLOWED_FORMATS[kind].includes(normalizedFormat)) {
    return res.status(400).json({
      error: `Unsupported ${kind} format. Allowed: ${ALLOWED_FORMATS[kind].join(", ")}`,
    });
  }
  const noteId =
    typeof req.body?.noteId === "string" && req.body.noteId ? req.body.noteId : null;
  // Destination the student picked in the app (e.g. lecture_note, course_reference).
  const task =
    typeof req.body?.task === "string" && TASKS.has(req.body.task)
      ? req.body.task
      : "none";

  const outcome = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    if (noteId) {
      const note = await tx.note.findFirst({
        where: { id: noteId },
        select: { userId: true },
      });
      if (note && note.userId !== user.id) {
        return { status: 403, error: "noteId does not match one of your notes" };
      }
      if (!note) {
        // The foreign key constraint requires note to exist in Postgres before referencing it.
        return {
          status: 409,
          error: "Note not found. Please sync notes before signing uploads.",
        };
      }
    }
    const created = await tx.asset.create({
      data: {
        userId: user.id,
        kind,
        publicId: "pending",
        storageProvider,
        resourceType: RESOURCE_TYPES[kind],
        format: normalizedFormat,
        status: "pending",
        noteId,
        task,
      },
    });
    // Restricted assets are only retrievable through signed delivery URLs.
    const publicId = `sua/${user.id}/${created.id}`;
    const asset = await tx.asset.update({
      where: { id: created.id },
      data: { publicId },
    });
    return { asset };
  });

  if (outcome.error) {
    return res.status(outcome.status || 400).json({ error: outcome.error });
  }
  const asset = outcome.asset;

  if (storageProvider === "neon") {
    try {
      const upload = await presignNeonObject(asset.publicId, "upload", mimeForFormat(normalizedFormat, kind));
      return res.status(201).json({
        ...shapeAsset(asset),
        uploadUrl: upload.url,
        uploadHeaders: upload.headers,
        uploadExpiresAt: upload.expiresAt,
        uploadMethod: "PUT",
        maxBytes: MAX_BYTES[kind],
      });
    } catch (error) {
      await withUser(identity.clerkId, (tx) => tx.asset.deleteMany({ where: { id: asset.id } }));
      console.error("Neon upload signing failed:", error?.message ?? error);
      return res.status(503).json({ error: "Could not prepare file upload" });
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const params = { public_id: asset.publicId, timestamp, type: "authenticated" };
  const signature = cloudinary.utils.api_sign_request(
    params,
    process.env.CLOUDINARY_API_SECRET,
  );

  res.status(201).json({
    ...shapeAsset(asset),
    uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${asset.resourceType}/upload`,
    apiKey: process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    timestamp,
    signature,
    type: "authenticated",
    maxBytes: MAX_BYTES[kind],
  });
});

// The client confirms an upload; the server verifies the asset actually
// exists in the selected provider before marking it active (never trusts a
// client URL or object metadata).
uploadsRouter.post("/:id/complete", async (req, res) => {
  const identity = await identityFromRequest(req);
  const { id } = req.params;
  const claimedPublicId = String(req.body?.publicId ?? "");

  const existingAsset = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    return tx.asset.findFirst({ where: { id, userId: user.id } });
  });

  if (!existingAsset) return res.status(404).json({ error: "Asset not found" });
  let outcome;
  if (existingAsset.status === "active") {
    outcome = { status: 200, asset: existingAsset };
  } else {
    if (!claimedPublicId || claimedPublicId !== existingAsset.publicId) {
      return res.status(400).json({ error: "publicId does not match this upload" });
    }

    // Verify storage outside the RLS transaction. Neon's object read can take
    // longer than Prisma's interactive transaction window, so keeping network
    // I/O here prevents holding a database connection while waiting on storage.
    let remote;
    try {
      remote = storageProviderOf(existingAsset) === "neon"
        ? await verifyNeonObject(existingAsset.publicId, MAX_BYTES[existingAsset.kind])
        : await fetchRemoteWithRetry(existingAsset.publicId, existingAsset.resourceType);
    } catch (err) {
      console.error(`${storageProviderOf(existingAsset)} complete verification failed for ${existingAsset.publicId}:`, err);
      if (/exceeds the allowed size/i.test(err?.message ?? "")) {
        return res.status(413).json({ error: "Uploaded file exceeds the allowed size" });
      }
      return res.status(400).json({ error: "Upload not found on storage provider" });
    }

    outcome = await withUser(identity.clerkId, async (tx) => {
      const user = await requireUser(tx, identity);
      const current = await tx.asset.findFirst({ where: { id, userId: user.id } });
      if (!current) return { status: 404, error: "Asset not found" };
      // A concurrent completion may already have activated this same asset.
      if (current.status === "active") return { status: 200, asset: current };
      if (current.publicId !== claimedPublicId || storageProviderOf(current) !== storageProviderOf(existingAsset)) {
        return { status: 409, error: "Asset changed during upload; retry completion" };
      }
      const updated = await tx.asset.update({
        where: { id: current.id },
        data: {
          status: "active",
          bytes: remote.bytes ?? 0,
          secureUrl: remote.secure_url ?? null,
        },
      });
      return { status: 200, asset: updated };
    });
  }

  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });

  let asset = outcome.asset;
  // The note may have been deleted while the bytes were in flight. Asset.noteId
  // is SetNull, so a null here means the note was removed after signing; do not
  // extract text for, or enqueue work against, a note the student deleted.
  if (asset.noteId) {
    const noteAlive = await withUser(identity.clerkId, async (tx) => {
      const user = await requireUser(tx, identity);
      const note = await tx.note.findFirst({
        where: { id: asset.noteId, userId: user.id },
        select: { id: true },
      });
      return Boolean(note);
    });
    if (!noteAlive) {
      const orphan = asset;
      await withUser(identity.clerkId, async (tx) => {
        const user = await requireUser(tx, identity);
        await tx.asset.deleteMany({ where: { id: orphan.id, userId: user.id } });
      }).catch(() => {});
      try {
        await deleteAssetObject(orphan);
      } catch (error) {
        console.warn(`Orphan asset cleanup failed for ${orphan.publicId}:`, error);
      }
      return res.status(410).json({ error: "Note was deleted" });
    }
  }
  // Parse the document once its bytes are confirmed — outside the transaction
  // so a slow download can't hold a database connection open. Re-runs only if
  // a previous attempt failed (extractedText still null).
  if (
    asset.kind === "document" &&
    !asset.extractedText &&
    asset.bytes > 0 &&
    asset.bytes <= MAX_EXTRACT_BYTES
  ) {
    try {
      const text = await extractFromStorage(asset);
      if (text) {
        const targetId = asset.id;
        asset = await withUser(identity.clerkId, (tx) =>
          tx.asset.update({
            where: { id: targetId },
            data: { extractedText: text },
          }),
        );
      }
    } catch (error) {
      console.warn(
        `Extraction failed for asset ${asset.id}:`,
        error?.message ?? error,
      );
    }
  }
  // A conversion-marked upload starts its AI job as soon as both halves are
  // on the server (extraction may offset the note-sync race either way; the
  // sync route triggers the other direction).
  if (asset.noteId && asset.task && asset.task !== "none") {
    try {
      await maybeEnqueueGeneration(identity.clerkId, asset.noteId);
    } catch (error) {
      console.warn(
        `Generation enqueue failed for asset ${asset.id}:`,
        error?.message ?? error,
      );
    }
  }
  res.status(outcome.status).json(shapeAsset(asset));
});

assetsRouter.get("/:id/url", async (req, res) => {
  const identity = await identityFromRequest(req);
  const { id } = req.params;
  const asset = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    return tx.asset.findFirst({ where: { id, userId: user.id, status: "active" } });
  });
  if (!asset) return res.status(404).json({ error: "Asset not found" });

  try {
    const signed = await assetDownloadUrl(asset);
    res.json({ id: asset.id, url: signed.url, expiresIn: storageProviderOf(asset) === "neon" ? 900 : null });
  } catch (error) {
    console.error(`Asset URL signing failed for ${asset.id}:`, error?.message ?? error);
    res.status(503).json({ error: "Could not prepare file access" });
  }
});

assetsRouter.delete("/:id", async (req, res) => {
  const identity = await identityFromRequest(req);
  const { id } = req.params;

  const asset = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    return tx.asset.findFirst({ where: { id, userId: user.id } });
  });
  if (!asset) return res.status(404).json({ error: "Asset not found" });

  try {
    await deleteAssetObject(asset);
  } catch (err) {
    console.error(`${storageProviderOf(asset)} object delete failed for ${asset.publicId}`, err);
    return res.status(502).json({ error: "Could not delete file; try again" });
  }

  await withUser(identity.clerkId, async (tx) => {
    await tx.asset.deleteMany({ where: { id: asset.id, userId: asset.userId } });
  });
  res.status(204).end();
});
