import { Router } from "express";
import { cloudinary, cloudinaryConfigured } from "../config/cloudinary.js";
import { withUser } from "../lib/db.js";
import { extractDocumentText } from "../lib/extract.js";
import { maybeEnqueueGeneration } from "../lib/pipeline.js";
import { ensureUser } from "../lib/user.js";
import { identityFromRequest } from "../lib/identity.js";

export const uploadsRouter = Router();
export const assetsRouter = Router();

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
  const url = cloudinary.url(asset.publicId, {
    resource_type: asset.resourceType,
    type: "authenticated",
    sign_url: true,
    secure: true,
  });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`storage fetch failed (${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return extractDocumentText(buffer, asset.format, asset.kind);
}

function requireStorage(res) {
  if (!cloudinaryConfigured()) {
    res.status(503).json({ error: "File storage is not configured" });
    return false;
  }
  return true;
}

// Clients upload straight to Cloudinary with these signed parameters, so
// large files never proxy through the API and secrets never leave the server.
uploadsRouter.post("/sign", async (req, res) => {
  if (!requireStorage(res)) return;
  const identity = await identityFromRequest(req);
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
  // Destination the student picked in the app; audio segments never carry one.
  const task =
    typeof req.body?.task === "string" && TASKS.has(req.body.task)
      ? req.body.task
      : "none";
  if (task !== "none" && !(kind in { document: 1, image: 1 })) {
    return res.status(400).json({
      error: "AI conversion is only available for documents and images",
    });
  }

  const outcome = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
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
// exists on Cloudinary before marking it active (never trusts client URLs).
uploadsRouter.post("/:id/complete", async (req, res) => {
  if (!requireStorage(res)) return;
  const identity = await identityFromRequest(req);
  const { id } = req.params;
  const claimedPublicId = String(req.body?.publicId ?? "");

  const outcome = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    const asset = await tx.asset.findFirst({ where: { id, userId: user.id } });
    if (!asset) return { status: 404, error: "Asset not found" };
    if (asset.status === "active") return { status: 200, asset };
    if (!claimedPublicId || claimedPublicId !== asset.publicId) {
      return { status: 400, error: "publicId does not match this upload" };
    }
    let remote;
    try {
      remote = await cloudinary.api.resource(asset.publicId, {
        resource_type: asset.resourceType,
      });
    } catch {
      return { status: 400, error: "Upload not found on storage provider" };
    }
    const updated = await tx.asset.update({
      where: { id: asset.id },
      data: {
        status: "active",
        bytes: remote.bytes ?? 0,
        secureUrl: remote.secure_url ?? null,
      },
    });
    return { status: 200, asset: updated };
  });

  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });

  let asset = outcome.asset;
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
  if (!requireStorage(res)) return;
  const identity = await identityFromRequest(req);
  const { id } = req.params;
  const asset = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    return tx.asset.findFirst({ where: { id, userId: user.id, status: "active" } });
  });
  if (!asset) return res.status(404).json({ error: "Asset not found" });

  const url = cloudinary.url(asset.publicId, {
    resource_type: asset.resourceType,
    type: "authenticated",
    sign_url: true,
    secure: true,
  });
  res.json({ id: asset.id, url, expiresIn: null });
});

assetsRouter.delete("/:id", async (req, res) => {
  const identity = await identityFromRequest(req);
  const { id } = req.params;

  const asset = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    return tx.asset.findFirst({ where: { id, userId: user.id } });
  });
  if (!asset) return res.status(404).json({ error: "Asset not found" });

  if (cloudinaryConfigured() && asset.publicId !== "pending") {
    try {
      await cloudinary.uploader.destroy(asset.publicId, {
        resource_type: asset.resourceType,
      });
    } catch (err) {
      console.error(`Cloudinary destroy failed for ${asset.publicId}`, err);
      return res.status(502).json({ error: "Could not delete file; try again" });
    }
  }

  await withUser(identity.clerkId, async (tx) => {
    await tx.asset.deleteMany({ where: { id: asset.id, userId: asset.userId } });
  });
  res.status(204).end();
});
