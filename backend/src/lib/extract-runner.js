import { prisma } from "../config/prisma.js";
import { MAX_TEXT_CHARS, extractDocumentIncremental, renderPdfPage } from "./extract.js";
import { readAssetBytes } from "./storage.js";
import { geminiImageText } from "./ai.js";
import { notePipeline } from "../config/ai-pipeline.js";

/**
 * Background document extraction.
 *
 * Upload completion verifies the object and returns immediately; this module
 * reads the bytes, extracts page by page with an early stop on the character
 * and page caps, OCRs only pages without a text layer, and persists progress.
 * The whole run is fail-soft: extraction errors are stored on the asset and
 * never fail the upload or the note.
 *
 * State lives on Asset (migration 16):
 *   pending -> running -> done | partial | failed
 * `running` rows untouched for EXTRACT_STALE_RUNNING_MS are reclaimed by the
 * next pass, so a killed serverless invocation cannot wedge an asset.
 */

const PROGRESS_FLUSH_PAGES = 5;
const PROGRESS_FLUSH_MS = 3_000;

/** Thrown by the pipeline while an upload-time extraction is still reading. */
export class ExtractionPendingError extends Error {
  constructor(assetId) {
    super(`Extraction is still running for asset ${assetId}`);
    this.name = "ExtractionPendingError";
    this.retryable = true;
  }
}

function staleBefore() {
  return new Date(Date.now() - notePipeline.extractStaleRunningMs);
}

function pageCapFor(asset) {
  return asset.task === "course_reference"
    ? notePipeline.maxReferencePages
    : notePipeline.maxNotePages;
}

function joinText(...parts) {
  return parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_TEXT_CHARS);
}

/**
 * Marks fresh work as running and starts it after the response is sent.
 * `waitUntil` keeps the function alive on Vercel; local dev gets a plain
 * fire-and-forget promise (same pattern as the Postgres job queue).
 *
 * When extraction settles, the note's AI conversion is enqueued here rather
 * than from /complete, so generation never starts on an unread file.
 */
export async function scheduleAssetExtraction(assetId, { clerkId = null } = {}) {
  const task = runAssetExtraction(assetId, { claimed: true, clerkId })
    .catch((error) => {
      console.warn(`[extract] asset=${assetId} scheduler failed (${error?.name ?? "Error"})`);
      return null;
    });
  try {
    const vercel = await import("@vercel/functions");
    if (typeof vercel?.waitUntil === "function") {
      vercel.waitUntil(task);
      return;
    }
  } catch {
    // Not running on Vercel, or @vercel/functions is unavailable.
  }
  void task;
}

/**
 * Runs extraction passes until the document is read, capped, or the time
 * budget is exhausted. Returns the settled asset summary, or null when
 * another invocation owns the work.
 *
 * `claimed: true` skips the atomic claim — used right after /complete (or the
 * on-demand pipeline path) has already taken ownership of the row.
 */
export async function runAssetExtraction(assetId, { claimed = false, clerkId = null } = {}) {
  if (!claimed) {
    const claim = await prisma.asset
      .updateMany({
        where: {
          id: assetId,
          OR: [
            { extractState: { in: ["pending", "failed", "partial"] } },
            { extractState: "running", updatedAt: { lt: staleBefore() } },
          ],
        },
        data: { extractState: "running" },
      })
      .catch(() => null);
    if (!claim || claim.count === 0) return null;
  }

  const asset = await prisma.asset.findUnique({ where: { id: assetId } }).catch(() => null);
  if (!asset) return null;
  if (asset.kind !== "document") {
    await settle(assetId, { extractState: "done" });
    return null;
  }

  const startedAt = Date.now();
  let downloadMs = 0;
  let parseMs = 0;
  let ocrMs = 0;
  let overallOcrPages = 0;
  let baseText = String(asset.extractedText ?? "").trim();
  let startPage = Math.max(1, asset.extractNextPage || 1);
  let pagesRead = Math.max(0, asset.extractedPages || 0);
  let totalPages = Math.max(0, asset.totalPages || 0);
  let truncated = Boolean(asset.extractTruncated);
  let lastFlushAt = 0;
  let lastFlushPage = 0;
  let state = "partial";
  let nextPage = startPage;

  try {
    if (!asset.bytes || asset.bytes <= 0) {
      await settle(assetId, { extractState: "failed", extractErrorCode: "empty_upload" });
      await enqueueConversion(clerkId, asset);
      return null;
    }

    const downloadStart = Date.now();
    const buffer = await readAssetBytes(asset);
    downloadMs = Date.now() - downloadStart;
    if (!buffer || !buffer.length) {
      await settle(assetId, { extractState: "failed", extractErrorCode: "empty_object" });
      await enqueueConversion(clerkId, asset);
      return null;
    }
    if (!matchesFileSignature(buffer, String(asset.format ?? "").toLowerCase())) {
      console.warn(`[extract] asset=${asset.id} signature mismatch (format=${asset.format ?? "?"})`);
    }

    const maxPages = pageCapFor(asset);
    const budgetMs = notePipeline.extractBudgetMs;
    const canOcr = Boolean(process.env.GEMINI_API_KEY);

    for (;;) {
      const remainingBudget = budgetMs - (Date.now() - startedAt);
      if (remainingBudget < 1_000) {
        state = "partial";
        nextPage = startPage;
        break;
      }

      const passStartPage = startPage;
      const result = await extractDocumentIncremental(buffer, asset.format, asset.kind, {
        startPage: passStartPage,
        maxPages: Math.max(1, maxPages - (passStartPage - 1)),
        maxChars: MAX_TEXT_CHARS,
        budgetMs: remainingBudget,
        ocr: canOcr
          ? {
              minChars: notePipeline.ocrMinChars,
              concurrency: notePipeline.ocrConcurrency,
              timeoutMs: notePipeline.ocrPageTimeoutMs,
              ocrPage: (page) => ocrPdfPage(buffer, page),
            }
          : null,
        // Persist a resumable checkpoint every few pages, so a lost function
        // keeps the pages it already read instead of starting over.
        onPage: (progress) => {
          const now = Date.now();
          if (
            progress.pagesUsed - lastFlushPage < PROGRESS_FLUSH_PAGES &&
            now - lastFlushAt < PROGRESS_FLUSH_MS
          ) {
            return undefined;
          }
          lastFlushAt = now;
          lastFlushPage = progress.pagesUsed;
          return prisma.asset
            .updateMany({
              where: { id: assetId },
              data: {
                extractState: "running",
                extractedText: joinText(baseText, progress.text) || null,
                extractedPages: passStartPage - 1 + progress.pagesUsed,
                totalPages: progress.totalPages || totalPages,
                extractNextPage: passStartPage + progress.pagesUsed,
                extractTruncated: truncated || Boolean(progress.truncated),
              },
            })
            .catch(() => {});
        },
      });

      if (!result) {
        await settle(assetId, {
          extractState: baseText ? "partial" : "failed",
          extractedText: baseText || null,
          extractedPages: pagesRead,
          totalPages,
          extractNextPage: startPage,
          extractErrorCode: "parse_failed",
        });
        await enqueueConversion(clerkId, asset);
        return null;
      }

      parseMs += result.timings.parseMs;
      ocrMs += result.timings.ocrMs;
      overallOcrPages += result.ocrPages;
      totalPages = result.totalPages || totalPages;
      pagesRead = Math.max(pagesRead, passStartPage - 1 + result.pagesUsed);
      truncated = truncated || result.truncated;
      baseText = joinText(baseText, result.text);

      if (result.partial && result.nextPage && Date.now() - startedAt < budgetMs - 1_000) {
        startPage = result.nextPage;
        continue;
      }
      state = result.partial ? "partial" : "done";
      nextPage = result.partial ? (result.nextPage ?? passStartPage) : 1;
      break;
    }

    await settle(assetId, {
      extractState: state,
      extractedText: baseText || null,
      extractedPages: pagesRead,
      totalPages,
      extractNextPage: nextPage,
      extractTruncated: truncated,
      extractErrorCode: null,
    });

    console.log(
      `[extract] asset=${asset.id} format=${asset.format ?? "?"} bytes=${asset.bytes} ` +
        `pages=${pagesRead}/${totalPages} ocrPages=${overallOcrPages} ` +
        `parseMs=${Math.round(parseMs)} ocrMs=${Math.round(ocrMs)} downloadMs=${downloadMs} ` +
        `totalMs=${Date.now() - startedAt} state=${state} truncated=${truncated}`,
    );

    // A settled read is enough to generate: `partial` means the budget ran out
    // with pages still unread, and the pipeline resumes those pages itself.
    if (state !== "failed" && asset.noteId && asset.task && asset.task !== "none") {
      await enqueueConversion(clerkId, asset);
    }
    return { state, pagesRead, totalPages, truncated };
  } catch (error) {
    const code = errorCodeFor(error);
    await settle(assetId, {
      extractState: baseText ? "partial" : "failed",
      extractedText: baseText || null,
      extractedPages: pagesRead,
      totalPages,
      extractNextPage: startPage,
      extractErrorCode: code,
    });
    // Never log file names, URLs, tokens or bytes: only the asset id and code.
    console.warn(`[extract] asset=${assetId} failed code=${code}`);
    await enqueueConversion(clerkId, asset);
    return null;
  }
}

/**
 * The AI job is created only after the file has been read. Imported lazily so
 * uploads do not pull the generation stack into every request module graph.
 */
async function enqueueConversion(clerkId, asset) {
  try {
    const owner = clerkId
      ? clerkId
      : (await prisma.user.findUnique({ where: { id: asset.userId }, select: { clerkId: true } }))?.clerkId;
    if (!owner) return;
    const { maybeEnqueueGeneration } = await import("./pipeline.js");
    await maybeEnqueueGeneration(owner, asset.noteId);
  } catch (error) {
    console.warn(`[extract] asset=${asset.id} enqueue failed (${error?.name ?? "Error"})`);
  }
}

async function settle(assetId, data) {
  await prisma.asset.updateMany({ where: { id: assetId }, data }).catch(() => {});
}

function errorCodeFor(error) {
  const message = String(error?.message ?? error).toLowerCase();
  if (message.includes("exceed") || message.includes("size")) return "size_rejected";
  if (message.includes("not found") || message.includes("404")) return "object_missing";
  if (message.includes("storage") || message.includes("fetch") || message.includes("network")) {
    return "storage_failed";
  }
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  return "extract_failed";
}

async function ocrPdfPage(buffer, pageNumber) {
  const image = await renderPdfPage(buffer, pageNumber, notePipeline.ocrScale);
  if (!image) return null;
  const result = await geminiImageText({ bytes: image, mimeType: "image/png" });
  return result?.text ?? null;
}

// The declaration was previously checked inline on /complete; the background
// worker now owns the bytes, so the same non-fatal warning lives here.
function matchesFileSignature(buffer, format) {
  if (!buffer || buffer.length < 4) return true;
  if (format === "pdf") {
    return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
  }
  if (format === "docx" || format === "pptx") {
    return (
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
      (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
    );
  }
  if (format === "ppt") {
    return buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
  }
  return true;
}

/**
 * Pipeline entry point: guarantees the asset has been read before generation
 * uses it. Runs extraction when the asset is pending, failed, or only partly
 * read, and reports "still running" as a retryable error so the job waits
 * instead of generating from an unread file.
 */
export async function ensureAssetExtracted(asset) {
  if (!asset || asset.kind !== "document") return asset;
  const hasText = Boolean(String(asset.extractedText ?? "").trim());
  // Legacy assets uploaded before this state machine carry text with state
  // "pending": they are already read.
  if (hasText && asset.extractState !== "partial" && asset.extractState !== "running") {
    return asset;
  }
  if (asset.extractState === "done" && !hasText) return asset;
  if (!asset.bytes || asset.bytes <= 0) return asset;

  if (
    asset.extractState === "running" &&
    new Date(asset.updatedAt).getTime() > Date.now() - notePipeline.extractStaleRunningMs
  ) {
    throw new ExtractionPendingError(asset.id);
  }

  const ran = await runAssetExtraction(asset.id);
  const fresh = await prisma.asset.findUnique({ where: { id: asset.id } }).catch(() => null);
  if (!ran && fresh?.extractState === "running") {
    throw new ExtractionPendingError(asset.id);
  }
  return fresh ?? asset;
}
