/**
 * Resumable page-wise extraction for uploaded documents.
 *
 * /complete only verifies the object and marks the asset pending; this module
 * does the actual reading in background invocations (Vercel waitUntil, the
 * jobs/tick cron, or an opportunistic kick when the client polls a status
 * endpoint). One pass has a hard time budget; whatever it finishes is stored
 * on SourceChunk rows and asset progress columns, so the next pass — same
 * code, any caller — continues from asset.nextPage and never repeats work.
 *
 * All external I/O (storage read, PDF parse, page render, OCR) happens here,
 * outside withUser. Database writes are short direct-prisma transactions
 * (infra writes, runner-style): the owner role behind DATABASE_URL bypasses
 * RLS, and chunk rows still carry userId for the row-level policies.
 *
 * Logs carry ids, counts, stage names, durations and error codes only — never
 * note content or extracted text.
 */

import { createHash } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { readAssetBytes } from "./storage.js";
import {
  extractPdfPages,
  extractDocument,
  extractEmbeddedImages,
  pdfOutline,
  renderPdfPage,
  MAX_TEXT_CHARS,
} from "./extract.js";
import { geminiImageText, geminiOcrBatch } from "./ai.js";
import { longDoc, notePipeline, documentRead } from "../config/ai-pipeline.js";
import {
  nativeReadBlocked,
  nativeReadEligible,
  nativeReadEnabled,
  readDocumentNatively,
  readEmbeddedVisuals,
} from "./native-read.js";

const OCR_PAGE_SCALE = notePipeline.ocrScale ?? 2;

// A claim that died mid-pass is retried after this stale window.
const RUNNING_STALE_MS = 8 * 60_000;

// Below this much remaining pass budget, a native read is not attempted: the
// request would be cut off, and the resumable extractor can still make progress.
const NATIVE_MIN_BUDGET_MS = 25_000;

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

function warn(code, message) {
  console.warn(`[extract] ${code}: ${message}`);
}

/** Cheap magic-bytes check, ported verbatim from the old /complete path. */
function formatMatchesSignature(buffer, format) {
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
  return true;
}

/**
 * Atomically claim one document asset whose extraction is unfinished.
 * Claimable: pending, partial, or running-but-stale (pass that died).
 * FOR UPDATE SKIP LOCKED so concurrent triggers never double-run the asset.
 */
export async function claimExtractionAsset({ targetAssetId = null } = {}) {
  const staleAfter = `${Math.round(RUNNING_STALE_MS / 1000)} seconds`;
  return prisma.$transaction(async (tx) => {
    const rows = await (targetAssetId
      ? tx.$queryRaw`
          SELECT a."id" FROM "assets" a
          WHERE a."kind" = 'document' AND a."status" = 'active' AND a."id" = ${targetAssetId}
            AND (
              a."extractState" IN ('pending', 'partial')
              OR (a."extractState" = 'running' AND a."updatedAt" < NOW() - ${staleAfter}::interval)
            )
          LIMIT 1 FOR UPDATE SKIP LOCKED
        `
      : tx.$queryRaw`
          SELECT a."id" FROM "assets" a
          WHERE a."kind" = 'document' AND a."status" = 'active'
            AND (
              a."extractState" IN ('pending', 'partial')
              OR (a."extractState" = 'running' AND a."updatedAt" < NOW() - ${staleAfter}::interval)
            )
          ORDER BY a."updatedAt" ASC
          LIMIT 1 FOR UPDATE SKIP LOCKED
        `);
    if (!rows.length) return null;
    await tx.$executeRaw`
      UPDATE "assets" SET "extractState" = 'running', "updatedAt" = NOW()
      WHERE "id" = ${rows[0].id}
    `;
    return rows[0].id;
  }).catch((error) => {
    warn("CLAIM_FAILED", error?.message ?? error);
    return null;
  });
}

/**
 * Fire-and-forget trigger; mirrors lib/queue.js's triggerRunner (waitUntil on
 * Vercel, floating promise in local dev).
 */
export async function triggerExtraction(assetId) {
  const run = extractNext({ targetAssetId: assetId }).catch((error) => {
    warn("TRIGGER_ERROR", error?.message ?? error);
  });
  try {
    const vercel = await import("@vercel/functions").catch(() => null);
    if (typeof vercel?.waitUntil === "function") {
      vercel.waitUntil(run);
      return;
    }
  } catch {
    // Not on Vercel.
  }
}

/**
 * Run up to `maxAssets` extraction passes. Called by the tick cron, the
 * status-poll kick and the waitUntil trigger (which targets one asset).
 */
export async function extractNext({
  maxAssets = 1,
  targetAssetId = null,
  budgetMs = longDoc.extractBudgetMs,
} = {}) {
  let passes = 0;
  for (let i = 0; i < maxAssets; i += 1) {
    const assetId = await claimExtractionAsset({ targetAssetId });
    if (!assetId) break;
    try {
      await runExtractionPass(assetId, budgetMs);
      passes += 1;
    } catch (error) {
      warn("PASS_ERROR", `asset ${assetId}: ${error?.message ?? error}`);
      // Leave the pass resumable; the next claim picks it back up.
      await prisma.asset.updateMany({
        where: { id: assetId, extractState: "running" },
        data: { extractState: "partial", updatedAt: new Date() },
      }).catch(() => {});
    }
    if (targetAssetId) break;
  }
  return { passes };
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

function failAsset(assetId, code) {
  return prisma.asset
    .update({ where: { id: assetId }, data: { extractState: "failed", extractErrorCode: code } })
    .catch(() => {});
}

/** Entry point for one extraction pass on one already-claimed asset. */
export async function runExtractionPass(assetId, budgetMs = longDoc.extractBudgetMs) {
  const started = Date.now();
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset || asset.kind !== "document" || asset.status !== "active") return null;

  const format = String(asset.format ?? "").toLowerCase();
  if (format === "ppt") {
    // Binary .ppt cannot be parsed in serverless JS. An honest failed state
    // beats pretending to process it.
    await failAsset(assetId, "UNREADABLE_PPT");
    warn("SKIPPED", `asset ${assetId}: legacy .ppt binary format; re-export as .pptx`);
    return { state: "failed" };
  }

  let bytes;
  try {
    bytes = await readAssetBytes(asset);
  } catch (error) {
    await failAsset(assetId, "STORAGE_ERROR");
    warn("STORAGE_ERROR", `asset ${assetId}: ${error?.message ?? error}`);
    return { state: "failed" };
  }
  if (!bytes?.length) {
    await failAsset(assetId, "UNREADABLE_FILE");
    return { state: "failed" };
  }
  if (!formatMatchesSignature(bytes, format)) {
    // Same behaviour /complete always had: warn and continue — the extension
    // may be wrong while the file itself is a readable PDF/Office file.
    warn("SIGNATURE", `asset ${assetId} format=${format} content does not match its extension; trying anyway`);
  }

  // Native read first: the model reads the document itself. Any failure or
  // ineligibility falls through to the deterministic page-wise extractor below.
  const native = await tryNativeRead(asset, bytes, format, started + budgetMs);
  if (native) return native;

  const outcome = await extractIntoChunks(asset, bytes, format, started + budgetMs);
  console.log(
    `[extract] stage=extract asset=${assetId} format=${format} pages=${outcome.pagesDone ?? 0}/${outcome.pagesTotal ?? 0} ocr=${outcome.ocrPages ?? 0} state=${outcome.state ?? "failed"} code=${outcome.errorCode ?? "-"}`,
  );
  return outcome;
}

/**
 * Native read attempt. Returns the same outcome shape as extractIntoChunks when
 * the model read the document, or null when the caller should run the legacy
 * extractor. Persistence is skipped on any failure: an upload must never die
 * because the model or its quota did.
 */
async function tryNativeRead(asset, bytes, format, deadline) {
  if (!nativeReadEnabled() || !nativeReadEligible(format)) return null;

  // The read is one request, but a slow 60-page document can outlive a pass
  // that is nearly out of budget. Keep enough of it for the request, otherwise
  // hand the file to the resumable extractor instead of timing out mid-read.
  const remaining = deadline ? deadline - Date.now() : documentRead.timeoutMs;
  if (remaining < NATIVE_MIN_BUDGET_MS) {
    warn("NATIVE_READ_SKIPPED", `asset ${asset.id} code=BUDGET remaining=${remaining}ms`);
    return null;
  }
  const timeoutMs = Math.min(documentRead.timeoutMs, remaining);

  let result;
  try {
    result = await readDocumentNatively({ bytes, format, timeoutMs });
  } catch (error) {
    warn("NATIVE_READ", `asset ${asset.id}: ${error?.message ?? error}`);
    return null;
  }
  if (!result?.ok) {
    if (result?.code && result.code !== "DISABLED") {
      warn(
        "NATIVE_READ_SKIPPED",
        `asset ${asset.id} code=${result.code}${result.pageCount ? ` pages=${result.pageCount}` : ""}`,
      );
    }
    return null;
  }

  const compat = result.pages
    .map((page) => (page.label ? `## ${page.label}\n\n${page.text}` : page.text))
    .join("\n\n");
  const truncated = compat.length > MAX_TEXT_CHARS;
  const rows = result.pages.map((page) => ({
    assetId: asset.id,
    userId: asset.userId,
    index: page.page,
    label: page.label,
    startPage: page.page,
    endPage: page.page,
    text: page.text,
    hash: sha1(page.text),
    status: "done",
  }));

  try {
    await prisma.$transaction(async (tx) => {
      await tx.sourceChunk.deleteMany({ where: { assetId: asset.id } });
      // Bookkeeping row: a page-less hint row the structure stage ignores when
      // it has no `headings` (native reads are already page-aligned).
      if (result.digest) {
        await tx.sourceChunk.create({
          data: {
            assetId: asset.id,
            userId: asset.userId,
            index: -1,
            text: "",
            hash: sha1(JSON.stringify(result.digest)),
            status: "done",
            digest: {
              nativeRead: {
                title: result.title,
                language: result.language,
                topics: result.digest.topics ?? [],
              },
            },
          },
        });
      }
      await tx.sourceChunk.createMany({ data: rows });
      await tx.asset.update({
        where: { id: asset.id },
        data: {
          extractState: "done",
          extractedText: compat.slice(0, MAX_TEXT_CHARS).trim() || null,
          pagesDone: result.pageCount,
          pagesTotal: result.pageCount,
          nextPage: result.pageCount + 1,
          truncated,
          ocrPages: 0,
          extractErrorCode: null,
        },
      });
    });
  } catch (error) {
    warn("NATIVE_READ_PERSIST", `asset ${asset.id}: ${error?.message ?? error}`);
    return null;
  }

  console.log(
    `[extract] stage=native_read asset=${asset.id} pages=${result.pageCount} aligned=${result.aligned} model=${result.model} ms=${result.ms} chars=${compat.length}`,
  );
  return {
    state: "done",
    pagesDone: result.pageCount,
    pagesTotal: result.pageCount,
    ocrPages: 0,
    truncated,
    native: true,
  };
}

/**
 * DOCX/PPTX: Gemini cannot open OOXML, so the text stays with the local
 * extractor — but the pictures inside the file (slide screenshots, pasted
 * scans, figures, charts) are readable. Each picture's transcription is merged
 * into the slide/section it belongs to, which is what makes an image-only deck
 * produce a source instead of "unreadable".
 *
 * Returns the same `{ segments, pageCount, truncated, headings }` shape as
 * extractDocument, or the input unchanged when there is nothing to add.
 */
export async function withEmbeddedVisuals(bytes, format, extracted, deadline) {
  if (!nativeReadEnabled() || !documentRead.embeddedImages) return extracted;
  if (nativeReadBlocked()) return extracted;

  const remaining = deadline ? deadline - Date.now() : documentRead.timeoutMs;
  if (remaining < NATIVE_MIN_BUDGET_MS) return extracted;

  const images = await extractEmbeddedImages(bytes, format, {
    minBytes: documentRead.minImageBytes,
    limit: documentRead.maxEmbeddedImages,
  });
  if (!images.length) return extracted;

  const visuals = await readEmbeddedVisuals({
    images,
    timeoutMs: Math.min(documentRead.timeoutMs, remaining),
  });
  if (!visuals.ok) {
    warn(
      "NATIVE_IMAGES_SKIPPED",
      `format=${format} code=${visuals.code} images=${images.length}`,
    );
    return extracted;
  }

  const merged = (extracted?.segments ?? []).map((segment) => ({ ...segment }));
  const bySlide = new Map();
  const loose = [];
  for (const image of images) {
    const text = visuals.text.get(image.id);
    if (!text) continue;
    if (format === "pptx" && image.page) {
      const list = bySlide.get(image.page) ?? [];
      list.push(text);
      bySlide.set(image.page, list);
    } else {
      loose.push(text);
    }
  }

  for (const [page, texts] of bySlide) {
    const block = texts.join("\n\n");
    const segment = merged.find((entry) => entry.index === page);
    if (segment) {
      segment.text = [segment.text, block].filter(Boolean).join("\n\n");
    } else {
      merged.push({ index: page, label: `Slide ${page}`, text: block });
    }
  }
  if (loose.length) {
    const block = `[Figures]\n\n${loose.join("\n\n")}`;
    // DOCX has no page structure: figures go at the end of the document.
    if (merged.length) merged[0].text = [merged[0].text, block].filter(Boolean).join("\n\n");
    else merged.push({ index: 1, label: null, text: block });
  }
  if (!merged.length) return extracted;

  merged.sort((a, b) => a.index - b.index);
  const segments = merged.map((segment) => ({
    ...segment,
    text: String(segment.text ?? "").trim(),
  }));
  const pageCount = Math.max(
    extracted?.pageCount ?? 0,
    segments[segments.length - 1]?.index ?? 0,
    segments.length,
  );
  console.log(
    `[extract] stage=native_images format=${format} images=${images.length} read=${visuals.text.size} calls=${visuals.calls} model=${visuals.model} ms=${visuals.ms}`,
  );
  return {
    segments,
    pageCount,
    truncated: extracted?.truncated ?? false,
    headings: extracted?.headings ?? [],
  };
}

async function extractIntoChunks(asset, bytes, format, deadline) {
  if (format !== "pdf" && format !== "docx" && format !== "pptx" && format !== "txt" && format !== "md") {
    await failAsset(asset.id, "UNREADABLE_FILE");
    return { state: "failed", errorCode: "UNREADABLE_FILE" };
  }

  // ---- 1. Produce the page list once per format --------------------------
  let segments;
  let headings = [];
  let pagesTotal = 0;
  if (format === "pdf") {
    const result = await extractPdfPages(bytes);
    if (!result) {
      await failAsset(asset.id, "UNREADABLE_FILE");
      return { state: "failed", errorCode: "UNREADABLE_FILE" };
    }
    segments = result.segments;
    pagesTotal = result.pageCount || segments.length;
  } else {
    const extracted = await extractDocument(bytes, format, "document");
    // DOCX/PPTX pictures are readable even when Gemini cannot open the file
    // itself; this is also the only way a screenshot-only deck has any content.
    // Only on the first pass: a resumed pass already merged them, and reading
    // every picture again would spend quota for nothing.
    const firstPass = (asset.nextPage ?? 1) <= 1 && (asset.pagesDone ?? 0) === 0;
    const result =
      (format === "docx" || format === "pptx") && firstPass
        ? await withEmbeddedVisuals(bytes, format, extracted, deadline)
        : extracted;
    if (!result) {
      await failAsset(asset.id, "UNREADABLE_FILE");
      return { state: "failed", errorCode: "UNREADABLE_FILE" };
    }
    segments = result.segments;
    headings = result.headings ?? [];
    pagesTotal = result.pageCount || segments.length || 1;
  }

  // ---- 2. Persist pages from asset.nextPage, caps and budget respected ---
  const cap = longDoc.maxPages;
  const maxChars = longDoc.maxSourceChars;
  const existing = await prisma.sourceChunk.findMany({
    where: { assetId: asset.id },
    select: { index: true, sectionId: true },
  });
  const haveRows = new Set(existing.map((row) => row.index));
  const [{ size: priorSize } = { size: 0 }] = await prisma.$queryRaw`
    SELECT COALESCE(SUM(LENGTH("text")), 0)::int AS size FROM "source_chunks" WHERE "assetId" = ${asset.id}
  `;

  let size = priorSize ?? 0;
  let pagesStored = 0;
  let cappedByLimit = false;
  let stoppedByBudget = false;
  // Points where a cap stopped mid-document, for user-facing notices.
  let rows = [];
  const storedPagesFlush = async () => {
    if (!rows.length) return;
    await prisma.sourceChunk.createMany({ data: rows });
    await prisma.asset.update({
      where: { id: asset.id },
      data: { pagesDone: pagesStored, nextPage: pagesStored + 1 },
    });
    rows = [];
  };

  for (const segment of segments) {
    const page = segment.index;
    if (page > cap) {
      cappedByLimit = true;
      break;
    }
    if (page < (asset.nextPage || 1) || haveRows.has(page)) continue;
    if (size >= maxChars) {
      cappedByLimit = true;
      break;
    }
    const raw = String(segment.text ?? "").trim();
    if (!raw && format === "pdf") {
      // Blank/scanned page placeholder: page numbers must stay true even for
      // pages with no text layer. The OCR sub-pass fills them in.
      if (!haveRows.has(page)) {
        rows.push({
          assetId: asset.id,
          userId: asset.userId,
          index: page,
          label: segment.label ?? null,
          startPage: page,
          endPage: page,
          text: "",
          hash: sha1(""),
          status: "pending",
        });
        pagesStored = page;
      }
      continue;
    }
    const slice = raw.length > maxChars - size ? raw.slice(0, maxChars - size) : raw;
    if (slice) {
      // Slide titles are stripped from the body text by the PPTX extractor;
      // persist them as part of the stored text so content is never lost.
      const withTitle =
        segment.title && !slice.startsWith(segment.title)
          ? `${segment.title}\n\n${slice}`
          : slice;
      rows.push({
        assetId: asset.id,
        userId: asset.userId,
        index: page,
        label: segment.label ?? null,
        startPage: page,
        endPage: page,
        text: withTitle,
        hash: sha1(withTitle),
        status: "pending",
      });
      size += withTitle.length;
      pagesStored = page;
    }
    if (rows.length >= 50) await storedPagesFlush();
    if (Date.now() > deadline) {
      stoppedByBudget = true;
      break;
    }
  }
  await storedPagesFlush();

  // ---- 3. DOCX heading hints ride on a bookkeeping row (index -1) --------
  if (headings.length && !haveRows.has(-1)) {
    await prisma.sourceChunk
      .create({
        data: {
          assetId: asset.id,
          userId: asset.userId,
          index: -1,
          text: "",
          hash: sha1(JSON.stringify(headings)),
          status: "done",
          digest: { headings },
        },
      })
      .catch(() => {});
  }

  // ---- 4. OCR sub-pass for thin-text pages, bounded -----------------------
  const ocrResult = await ocrThinPages({
    asset,
    bytes,
    deadline,
    ocrPagesDone: asset.ocrPages,
  });

  const storedCount = await prisma.sourceChunk.count({
    where: { assetId: asset.id, index: { gt: 0 } },
  });
  // Every page within the cap has a row (blank ones included): the extraction
  // genuinely finished everything the caps allow.
  const handledAll = storedCount >= Math.min(pagesTotal, cap) && !stoppedByBudget;
  const finalState = handledAll || cappedByLimit ? "done" : "partial";
  const truncated = cappedByLimit || stoppedByBudget || asset.truncated;

  // Compat: maintain the flat extracted-text column for legacy readers, with
  // the same 100k cap extract.js always applied.
  if (!asset.extractedText) {
    const compatRows = await prisma.sourceChunk.findMany({
      where: { assetId: asset.id, index: { gt: 0 } },
      orderBy: { index: "asc" },
      select: { text: true },
    });
    const compat = compatRows.map((row) => row.text).join("\n\n").slice(0, MAX_TEXT_CHARS).trim();
    if (compat) {
      await prisma.asset.update({ where: { id: asset.id }, data: { extractedText: compat } });
    }
  }

  await prisma.asset.update({
    where: { id: asset.id },
    data: {
      extractState: finalState,
      pagesDone: pagesStored,
      pagesTotal,
      nextPage: Math.min(pagesStored + 1, cap + 1),
      truncated,
      extractErrorCode: null,
    },
  });

  return {
    state: finalState,
    pagesDone: pagesStored,
    pagesTotal,
    ocrPages: (asset.ocrPages || 0) + ocrResult.ocrPages,
    truncated,
  };
}

/**
 * Render + OCR pages whose stored text is too thin to use. Batches several
 * pages per Gemini call with bounded concurrency and per-call timeout; falls
 * back to single-image calls when a batch cannot be aligned. All rendering
 * and network I/O happens outside any transaction.
 */
async function ocrThinPages({ asset, bytes, deadline, ocrPagesDone }) {
  const remaining = longDoc.ocrMaxPages - (ocrPagesDone || 0);
  if (remaining <= 0) return { ocrPages: 0 };

  const pendingRows = await prisma.sourceChunk.findMany({
    where: { assetId: asset.id, status: "pending" },
    orderBy: { index: "asc" },
    select: { index: true, text: true },
  });
  const thin = pendingRows.filter((row) => (row.text ?? "").trim().length < longDoc.ocrMinChars);
  if (!thin.length) return { ocrPages: 0 };

  let processed = 0;
  for (let start = 0; start < thin.length && processed < remaining; start += longDoc.ocrBatchPages) {
    if (Date.now() > deadline) break;
    const slice = thin.slice(start, start + Math.min(longDoc.ocrBatchPages, remaining - processed));
    const pages = [];
    for (const row of slice) {
      const image = await renderPdfPage(bytes, row.index, OCR_PAGE_SCALE);
      if (image) pages.push({ index: row.index, image });
    }
    if (!pages.length) break;

    let batchTexts = null;
    try {
      const batchResult = await geminiOcrBatch({ pages });
      if (batchResult.every((entry) => entry?.text !== null)) batchTexts = batchResult;
    } catch (error) {
      warn("OCR_BATCH", `asset ${asset.id}: ${error?.message ?? error}`);
    }

    for (const [slot, page] of pages.entries()) {
      let text = batchTexts?.[slot]?.text ?? null;
      if (text == null) {
        try {
          const single = await geminiImageText({ bytes: page.image, mimeType: "image/png" });
          text = single?.text ?? null;
        } catch (error) {
          warn("OCR_SINGLE", `asset ${asset.id} page ${page.index}: ${error?.message ?? error}`);
        }
      }
      processed += 1;
      const usable = String(text ?? "").trim();
      await prisma.sourceChunk.update({
        where: { assetId_index: { assetId: asset.id, index: page.index } },
        data: {
          text: usable,
          hash: sha1(usable),
          status: usable ? "done" : "failed",
          errorCode: usable ? null : "OCR_FAILED",
        },
      });
    }
    await prisma.asset
      .update({ where: { id: asset.id }, data: { ocrPages: (ocrPagesDone || 0) + processed } })
      .catch(() => {});
  }
  return { ocrPages: processed };
}
