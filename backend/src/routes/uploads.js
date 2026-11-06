import { Router } from "express";
import { cloudinary, cloudinaryConfigured } from "../config/cloudinary.js";
import { neonStorageConfigured, presignNeonObject } from "../config/neon-storage.js";
import {
  MAX_BYTES,
  MAX_UPLOAD_BYTES,
  assetDownloadUrl,
  deleteAssetObject,
  storageProviderOf,
  verifyNeonObject,
} from "../lib/storage.js";
import { withUser } from "../lib/db.js";
import {
  checkCompletion,
  needsExtraction,
  needsVerification,
} from "../lib/upload-intake.js";
import { shapeProcessing } from "../lib/processing/state.js";
import { startProcessing, triggerAssetExtraction } from "../lib/processing/start.js";
import { requireUser } from "../lib/users.js";
import { identityFromRequest } from "../lib/identity.js";

export { MAX_UPLOAD_BYTES };

export const uploadsRouter = Router();
export const assetsRouter = Router();

function mimeForFormat(format, kind) {
  const mimeByFormat = {
    pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ppt: "application/vnd.ms-powerpoint",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    heic: "image/heic", heif: "image/heif", m4a: "audio/mp4", mp3: "audio/mpeg",
    wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac",
  };
  return mimeByFormat[format] ?? (kind === "image" ? "image/jpeg" : "application/octet-stream");
}

// Where the student wants a document/photo converted once it lands.
const TASKS = new Set(["lecture_note", "course_reference"]);

const ALLOWED_FORMATS = {
  document: ["pdf", "pptx", "ppt", "txt", "docx", "md"],
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
    // Long-file extraction progress (additive): clients show pages/skips.
    extractState: asset.extractState ?? "none",
    pagesDone: asset.pagesDone ?? 0,
    pagesTotal: asset.pagesTotal ?? 0,
    truncated: asset.truncated ?? false,
    ocrPages: asset.ocrPages ?? 0,
    extractErrorCode: asset.extractErrorCode ?? null,
    createdAt: asset.createdAt,
  };
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
//
// Three transactions, not five: read (the asset and whether its note still
// exists), verify the object outside any transaction, then one locked write that
// activates the asset and marks it for extraction together. The response is the
// row as the database now holds it — answering with the pre-update object made a
// freshly completed document report `extractState: "none"` while the row said
// `pending`, and the client stopped asking for its text.
uploadsRouter.post("/:id/complete", async (req, res) => {
  const identity = await identityFromRequest(req);
  const { id } = req.params;
  const claimedPublicId = String(req.body?.publicId ?? "");

  const loaded = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    const asset = await tx.asset.findFirst({ where: { id, userId: user.id } });
    if (!asset) return { asset: null, noteAlive: false };
    // The note may have been deleted while the bytes were in flight. Asset.noteId
    // is SetNull, so no noteId means the upload was already detached.
    const noteAlive = asset.noteId
      ? Boolean(
          await tx.note.findFirst({
            where: { id: asset.noteId, userId: user.id },
            select: { id: true },
          }),
        )
      : false;
    return { asset, noteAlive };
  });

  if (!loaded.asset) return res.status(404).json({ error: "Asset not found" });
  const existingAsset = loaded.asset;

  // A dead parent means the upload must not be extracted or turned into a job.
  if (existingAsset.noteId && !loaded.noteAlive) {
    await withUser(identity.clerkId, async (tx) => {
      const user = await requireUser(tx, identity);
      await tx.asset.deleteMany({ where: { id: existingAsset.id, userId: user.id } });
    }).catch(() => {});
    try {
      await deleteAssetObject(existingAsset);
    } catch (error) {
      console.warn(`Orphan asset cleanup failed for ${existingAsset.publicId}:`, error);
    }
    return res.status(410).json({ error: "Note was deleted" });
  }

  const provider = storageProviderOf(existingAsset);
  let remote = null;
  if (needsVerification(existingAsset)) {
    // The same rule the locked write below applies: a publicId that no longer
    // matches is a conflict, not a file worth a storage round trip.
    const pre = checkCompletion(existingAsset, { claimedPublicId, provider });
    if (!pre.ok) return res.status(pre.status).json({ error: pre.error });
    // Verify storage outside the RLS transaction. Neon's object read can take
    // longer than Prisma's interactive transaction window, so keeping network
    // I/O here prevents holding a database connection while waiting on storage.
    try {
      remote =
        provider === "neon"
          ? await verifyNeonObject(existingAsset.publicId, MAX_BYTES[existingAsset.kind])
          : await fetchRemoteWithRetry(existingAsset.publicId, existingAsset.resourceType);
    } catch (err) {
      console.error(`${provider} complete verification failed for ${existingAsset.publicId}:`, err);
      if (/exceeds the allowed size/i.test(err?.message ?? "")) {
        return res.status(413).json({ error: "Uploaded file exceeds the allowed size" });
      }
      return res.status(400).json({ error: "Upload not found on storage provider" });
    }
  }

  const outcome = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    // Serialise duplicate completions: two concurrent requests must produce one
    // activation, not two "not active yet" reads followed by two updates.
    const locked = await tx.$queryRaw`
      SELECT "id" FROM "assets"
      WHERE "id" = ${id} AND "userId" = ${user.id}
      FOR UPDATE
    `;
    if (!Array.isArray(locked) || !locked.length) {
      return { status: 404, error: "Asset not found" };
    }
    let asset = await tx.asset.findFirst({ where: { id, userId: user.id } });
    const check = checkCompletion(asset, { claimedPublicId, provider });
    if (!check.ok) return check;

    if (asset.status !== "active") {
      asset = await tx.asset.update({
        where: { id: asset.id },
        data: {
          status: "active",
          bytes: remote?.bytes ?? asset.bytes ?? 0,
          secureUrl: remote?.secure_url ?? asset.secureUrl ?? null,
        },
      });
    }

    // Fast intake: never parse the file inside the request. Marking the row
    // pending is all /complete does; the page-wise pass runs in background.
    // Legacy assets keep their extractedText as the compat field, which is why
    // a row that already holds text is never re-parsed.
    const startExtraction = needsExtraction(asset);
    if (startExtraction) {
      asset = await tx.asset.update({
        where: { id: asset.id },
        data: { extractState: "pending" },
      });
    }
    return { status: 200, asset, startedExtraction: startExtraction };
  });

  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });

  const asset = outcome.asset;

  // Nothing is extracted or generated here: the object is verified, the row says
  // what it wants, and the orchestrator runs it. This endpoint is safe to call
  // repeatedly — one idempotency key per document + kind + processing version
  // means a retry cannot start a second run.
  let processing = null;
  const conversion = asset.task && asset.task !== "none" ? asset.task : null;
  if (asset.noteId && conversion) {
    const started = await startProcessing({
      noteId: asset.noteId,
      userId: asset.userId,
      kind: conversion,
      assetId: asset.kind === "document" ? asset.id : null,
    }).catch((error) => {
      console.warn(`processing start failed for asset ${asset.id}: ${error?.message ?? error}`);
      return null;
    });
    processing = shapeProcessing(started?.job ?? null);
  } else if (outcome.startedExtraction) {
    // Plain upload: extract the text for reading only, generate nothing. A
    // conversion above carries its own extraction stage, so it needs no second
    // run over the same file.
    await triggerAssetExtraction(asset.id).catch((error) => {
      console.warn(`extraction trigger failed for asset ${asset.id}: ${error?.message ?? error}`);
    });
  }
  res.status(outcome.status).json({ ...shapeAsset(asset), processing });
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
