/**
 * Long-file pipeline: Structure -> Chunk -> Map (checkpointed) -> Reduce ->
 * Sectioned one-note generation -> Verify -> Persist.
 *
 * One uploaded document always writes ONE Note row (the client-created note
 * id). Sections are `##` Markdown pages inside that note; the writer is
 * checkpointed per section so an interrupted job resumes without repeating
 * finished pages.
 *
 * The resumable extraction stage (lib/extraction.js) has already stored one
 * SourceChunk row per page/slide when this module runs. Everything here reads
 * rows, never the file; every stage is idempotent and checkpointed on the Job
 * row (job.checkpoint JSON), so a crash, restart or rate limit continues
 * without repeating finished work, and a regeneration with unchanged content
 * repays zero map calls (cache key: chunk hash + prompt version + model).
 *
 * Model calls and storage/network I/O happen OUTSIDE withUser. Database
 * writes are short transactions. Logs carry ids, counts, stage names,
 * durations and error codes only — never content.
 */

import { createHash } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { withUser } from "./db.js";
import { bulkModel, strongModel, chatCompletion, timeoutForDeadline, AiError } from "./ai.js";
import {
  digestChunk,
  digestToText,
  mapWithLimit,
  validateDigest,
  parseJsonObject,
} from "./note-pipeline.js";
import {
  PROMPT_VERSION,
  reducePrompt,
  overviewPrompt,
  sectionNotePrompt,
  sectionReferencePrompt,
} from "./prompts.js";
import {
  SECTION_PROMPT_VERSION,
  LONG_DOC_REVISION,
  longDoc,
  notePipeline,
  UserFacingError,
  JobYieldError,
  isUserFacing,
} from "../config/ai-pipeline.js";
import { validateStudyPack } from "../config/study-pack-schema.js";
import { checkSourceFidelity, normaliseForCompare } from "./numbers.js";
import { MAX_TEXT_CHARS } from "./extract.js";
import { purgeNoteRows, flushStorageDeletes } from "./note-deletion.js";
import {
  CheckpointWriteError,
  mergeCheckpointKeys,
  readJobCheckpoint,
  writeCheckpointEntry,
} from "./job-checkpoint.js";

// ---------------------------------------------------------------------------
// Reading chunks
// ---------------------------------------------------------------------------

/**
 * Load the chunk rows of a note's active document assets. Returns null when
 * the note has no long-file extraction (typed notes, legacy uploads) so the
 * caller falls back to the original single-shot pipeline untouched.
 */
export async function loadChunkedSource(clerkId, note) {
  const assetIds = (note.assets ?? [])
    .filter((asset) => asset.kind === "document" && asset.status === "active")
    .map((asset) => asset.id);
  if (!assetIds.length) return null;

  return withUser(clerkId, async (tx) => {
    const rows = await tx.sourceChunk.findMany({
      where: { assetId: { in: assetIds }, index: { gt: 0 } },
      orderBy: [{ assetId: "asc" }, { index: "asc" }],
    });
    const hints = await tx.sourceChunk.findFirst({
      where: { assetId: { in: assetIds }, index: -1 },
      select: { digest: true },
    });
    if (!rows.length) return null;
    return {
      rows: rows.filter(
        (row) =>
          row.status === "done" ||
          (row.status === "pending" && (row.text ?? "").length >= longDoc.ocrMinChars),
      ),
      structureHints: hints?.digest ?? {},
    };
  });
}

// ---------------------------------------------------------------------------
// Structure (3.3) + chunk grouping (3.4)
// ---------------------------------------------------------------------------

const NUMBERED_HEADING =
  /^(?:chapter|unit|module|section|part|appendix)\s+(?:\d+|[ivxlIVXL]{1,8}|[A-Za-z])\b|^(\d+(?:\.\d+){0,3})[).:]?\s+\S/i;
// Provider rate limits / exhausted daily quota deserve their own message, not
// the generic "too many parts failed" one.
const RATE_LIMIT_RE = /\b429\b|rate.?limit|quota|daily.?reset/i;
const ALL_CAPS = /^[A-Z][A-Z0-9 \-':,&]{7,63}$/;

/** Stable over the file's content: the rerun-guard hash of a chunked source.
 *  The revision keeps a done split-mode job from suppressing the rebuild. */
export function chunkedSourceHash(source) {
  return sha1(`${LONG_DOC_REVISION}|${source.rows.map((row) => row.hash ?? row.text ?? "").join("|")}`);
}

/**
 * Sections with title + startPage/endPage, preference order: extraction's
 * structure hints (DOCX heading levels stored on the -1 bookkeeping row),
 * numbered headings and ALL-CAPS lines in the page text, then fixed windows.
 * Sources with fewer than four stored rows (DOCX/TXT/Md land as one blob row)
 * get no structure split: they flow through the short path anyway.
 */
export function buildSections({ rows, structureHints = {}, pageCount }) {
  if (rows.length < 4) return [];
  const total = Math.max(pageCount ?? 0, rows[rows.length - 1]?.endPage ?? 1);

  if (Array.isArray(structureHints.headings) && structureHints.headings.length > 1) {
    const headings = structureHints.headings.map((heading, index) => ({
      id: `s${index + 1}`,
      title: String(heading.title ?? "").trim(),
    }));
    // Blob-footed formats (no per-page rows): split evenly by heading count.
    return spanSectionsByRows(headings, rows);
  }

  const scanned = [];
  for (const row of rows) {
    for (const line of String(row.text ?? "").split("\n").slice(0, 40)) {
      const trimmed = line.trim().replace(/[*_`]+/g, "");
      if (!trimmed || trimmed.length > 80) continue;
      if (NUMBERED_HEADING.test(trimmed) || ALL_CAPS.test(trimmed)) {
        const prev = scanned[scanned.length - 1];
        if (prev && normaliseForCompare(prev.title) === normaliseForCompare(trimmed)) continue;
        scanned.push({ title: trimmed, page: row.startPage });
      }
    }
  }
  if (scanned.length < 2) {
    // Fixed windows (~8 pages), at least two sections when the file is long.
    const windowPages = Math.max(4, Math.min(15, Math.ceil(total / 8)));
    const sections = [];
    for (let start = 1; start <= total; start += windowPages) {
      sections.push({
        id: `s${sections.length + 1}`,
        title: `Section ${sections.length + 1}`,
        startPage: start,
        endPage: Math.min(total, start + windowPages - 1),
      });
    }
    return sections.length > 1 ? sections : [];
  }
  const sections = [];
  for (const [index, anchor] of scanned.entries()) {
    sections.push({
      id: `s${sections.length + 1}`,
      title: anchor.title,
      startPage: anchor.page,
      endPage: index + 1 < scanned.length ? scanned[index + 1].page - 1 : total,
    });
  }
  return sections.filter((section) => section.startPage <= total && section.endPage >= section.startPage);
}

/** Page-less formats: equal row spans per anchor (no page numbers exist). */
function spanSectionsByRows(anchors, rows) {
  if (anchors.length < 2) return [];
  const cuts = anchors.slice(1).map((_, index) =>
    Math.max(1, Math.round(((index + 1) / anchors.length) * rows.length)),
  );
  return anchors.map((anchor, index) => {
    const startRow = index === 0 ? 0 : cuts[index - 1];
    const endRow = cuts[index] ?? rows.length;
    return {
      id: anchor.id,
      title: anchor.title,
      startPage: rows[startRow]?.startPage ?? 1,
      endPage: rows[Math.max(0, endRow - 1)]?.endPage ?? rows[rows.length - 1]?.endPage ?? 1,
      rowStart: startRow,
      rowEnd: endRow,
    };
  });
}

/**
 * Page rows assigned to sections, then grouped into map units: target
 * ~CHUNK_CHARS (10k) per unit, hard max 14k, never crossing a section
 * (heading) boundary, slight overlap via the first row repeat is unnecessary
 * because pages are intact units — page texts are atomic, which satisfies the
 * no-split formula/table/example rule.
 */
export function groupRowsIntoChunks({ rows, sections }) {
  // Very large sources: widen the chunk target so the map lands near ~90
  // groups (each group is one digest call) instead of spending the whole AI
  // call budget on small chunks. Small sources keep the 10k default.
  const totalChars = rows.reduce((sum, row) => sum + (row.text?.length ?? 0), 0);
  const chunkChars = Math.min(
    longDoc.maxChunkChars,
    Math.max(longDoc.chunkChars, Math.ceil(totalChars / 90)),
  );
  const chunkHardMaxChars = Math.max(longDoc.chunkHardMaxChars, Math.ceil(chunkChars * 1.4));
  const assigned = rows.map((row, index) => ({
    row,
    section: sections.find(
      (s) => row.startPage >= s.startPage && row.startPage <= s.endPage,
    ) ?? sections.find((s) => s.rowStart <= index && index < s.rowEnd) ?? sections[0] ?? null,
  }));

  const groups = [];
  for (const section of sections) {
    const sectionRows = assigned.filter((item) => item.section?.id === section.id).map((item) => item.row);
    let current = { rows: [], chars: 0 };
    const push = () => {
      if (!current.rows.length) return;
      groups.push({ sectionId: section.id, rows: current.rows });
      current = { rows: [], chars: 0 };
    };
    for (const row of sectionRows) {
      const chars = row.text?.length ?? 0;
      if (current.chars + chars > chunkHardMaxChars && current.rows.length) push();
      current.rows.push(row);
      current.chars += chars;
      if (current.chars >= chunkChars) push();
    }
    push();
  }
  // Orphan rows (no section match) still go through the same size caps — a
  // single DOCX blob row must never become one unbounded digest call.
  const orphans = assigned.filter((item) => !item.section).map((item) => item.row);
  if (orphans.length) {
    let bucket = [];
    let bucketChars = 0;
    const pushBucket = () => {
      if (!bucket.length) return;
      groups.push({ sectionId: null, rows: bucket });
      bucket = [];
      bucketChars = 0;
    };
    for (const row of orphans) {
      const chars = row.text?.length ?? 0;
      if (bucketChars + chars > chunkHardMaxChars && bucket.length) pushBucket();
      bucket.push(row);
      bucketChars += chars;
      if (bucketChars >= chunkChars) pushBucket();
    }
    pushBucket();
  }

  return groups.map((group, index) => {
    const rowsText = group.rows.map((row) => row.text ?? "").join("\n\n");
    const labels = group.rows.map((row) => row.label).filter(Boolean);
    return {
      index,
      sectionId: group.sectionId,
      rows: group.rows,
      text: rowsText,
      hash: sha1(group.rows.map((row) => row.hash ?? row.text ?? "").join("|")),
      labels,
      labelRange: rangeLabel(labels),
    };
  });
}

function sha1(value) {
  return createHash("sha1").update(String(value)).digest("hex");
}

function rangeLabel(labels) {
  if (!labels?.length) return "";
  const first = labels[0];
  const last = labels[labels.length - 1];
  return first === last ? first : `${first}-${last}`;
}

// ---------------------------------------------------------------------------
// Checkpoint (shared JSON column, one writer per stage)
// ---------------------------------------------------------------------------

/**
 * Every stage shares the single `Job.checkpoint` JSON column, so a write must
 * only replace the keys it owns. Writing the whole object from an in-memory
 * copy made stages clobber each other: the first reduce write dropped the
 * digest map, so an interrupted run redid the entire map and could never get
 * past "Pulling out important parts". Postgres `||` merges one level deep,
 * atomically, without a read-modify-write race between map workers.
 */
export function mergeCheckpoint(current, patch) {
  // Mirrors Postgres `||` exactly: top-level keys are replaced wholesale, so a
  // stage must pass the complete value for each key it owns (its in-memory map
  // is seeded from the row and grows), and other stages' keys survive untouched.
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return { ...base, ...(patch ?? {}) };
}

async function patchCheckpoint(jobId, patch, { progressIncrement = 0 } = {}, deps = null) {
  if (deps?.saveMapCheckpoint) {
    await deps.saveMapCheckpoint(patch, progressIncrement);
    return;
  }
  // Throws CheckpointWriteError when the row cannot take the patch. Swallowing
  // it (the old `.catch(warn)`) made a lost digest/section look saved and the
  // pass kept spending calls on work the next pass had to redo.
  await mergeCheckpointKeys(jobId, patch, { progressIncrement });
}

// ---------------------------------------------------------------------------
// Map (3.5)
// ---------------------------------------------------------------------------

const digestCacheKey = (group, model) => `${group.hash}:${PROMPT_VERSION}:${model}`;

/**
 * Digest every chunk with the cheap model under bounded concurrency.
 * Checkpointed on job.checkpoint.digests keyed by (hash, promptVersion,
 * model). Groups that repeatedly fail below MAX_FAILED_CHUNK_RATIO become
 * user-visible lost ranges; above it the job fails honestly.
 */
export async function mapDigests({ job, groups, courseContext, sourceType, deps }) {
  const model = bulkModel();
  const saved = { ...(job.checkpoint?.digests ?? {}) };
  const todo = groups.filter((group) => !saved[digestCacheKey(group, model)]);
  const failures = { ...(job.checkpoint?.digestFailures ?? {}) };
  let calls = 0;
  let rateLimited = false;
  let rateLimitError = null;
  let yielded = false;

  // Refuse pathological sources before spending a single model call: the
  // chunker already scales up to maxChunkChars, so more groups than the cap
  // means the file genuinely needs splitting into chapters.
  if (groups.length > longDoc.maxChunksPerJob) {
    throw new UserFacingError(
      `This file is too long for one pass (${groups.length} parts; the limit is ${longDoc.maxChunksPerJob}). ` +
        "Upload it in chapters — for example pages 1-150, then the rest.",
    );
  }

  // Optional sink for harnesses/tests: captures the checkpoint state that
  // production persists via prisma.job.update (which the real job row does).
  const emitCheckpoint = async () => {
    await deps.onCheckpoint?.({
      digests: saved,
      digestFailures: failures,
      mapCalls: (job.checkpoint?.mapCalls ?? 0) + calls,
    });
  };

  const persistMapState = async () => {
    await patchCheckpoint(
      job.id,
      {
        digests: saved,
        digestFailures: failures,
        mapCalls: (job.checkpoint?.mapCalls ?? 0) + calls,
      },
      {},
      deps,
    );
    await emitCheckpoint();
  };

  if (todo.length) {
    await deps.setStage("digesting");
    await prisma.job
      .update({ where: { id: job.id }, data: { progressTotal: groups.length, progressDone: groups.length - todo.length } })
      .catch(() => {});
  }

  await mapWithLimit(todo, longDoc.aiConcurrency, async (group) => {
    // The daily quota is gone — every further call is guaranteed to fail, so
    // stop spending them. Unattempted groups stay unsaved and resume later.
    if (rateLimited) return;
    // Out of invocation time: stop starting calls. Groups already in flight
    // still finish and checkpoint; the job is re-queued after the loop.
    if (deps.deadline && Date.now() > deps.deadline) {
      yielded = true;
      return;
    }
    const checkpoint = await prisma.job.findUnique({ where: { id: job.id }, select: { checkpoint: true } }).catch(() => null);
    const mapCalls = checkpoint?.checkpoint?.mapCalls ?? (job.checkpoint?.mapCalls ?? 0) + calls;
    if (mapCalls >= longDoc.maxAiCallsPerJob) {
      failures[group.hash] = { label: group.labelRange, code: "AI_CALL_BUDGET" };
      return;
    }
    calls += 1;
    try {
      const digest = await digestChunk(
        { index: group.index, labels: group.labels, text: group.text },
        { courseContext, sourceType, chunkCount: groups.length },
        deps,
      );
      saved[digestCacheKey(group, model)] = digest;
      delete failures[group.hash];
      await patchCheckpoint(
        job.id,
        { digests: saved, digestFailures: failures, mapCalls },
        { progressIncrement: 1 },
        deps,
      );
      await emitCheckpoint();
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      if (error?.kind === "rate_limit" || RATE_LIMIT_RE.test(error?.message ?? "")) {
        rateLimited = true;
        rateLimitError = error;
        failures[group.hash] = { label: group.labelRange, code: "RATE_LIMITED" };
      } else {
        failures[group.hash] = { label: group.labelRange, code: "DIGEST_FAILED" };
      }
      await persistMapState();
    }
  });

  await persistMapState();

  // Out of invocation time is not a failure: every finished digest is already
  // checkpointed, so hand the job back and let the next pass continue the map.
  if (yielded) throw new JobYieldError("map");

  // Second-chance sweep: transient provider errors (rate bursts, 5xx flaps)
  // often clear within seconds, so give failed groups one more try —
  // sequentially, on purpose, because parallel bursts are usually what broke
  // them. Budget/runtime still bound the sweep; anything still failing is
  // judged by the failure-ratio guard below.
  const retryList = rateLimited
    ? []
    : groups.filter(
        (group) => failures[group.hash] && failures[group.hash].code !== "RATE_LIMITED",
      );
  if (retryList.length) {
    await deps.setStage("digesting");
    for (const group of retryList) {
      const mapCalls = (job.checkpoint?.mapCalls ?? 0) + calls;
      if (mapCalls >= longDoc.maxAiCallsPerJob) break;
      calls += 1;
      try {
        const digest = await digestChunk(
          { index: group.index, labels: group.labels, text: group.text },
          { courseContext, sourceType, chunkCount: groups.length },
          deps,
        );
        saved[digestCacheKey(group, model)] = digest;
        delete failures[group.hash];
        await patchCheckpoint(
          job.id,
          { digests: saved, digestFailures: failures, mapCalls },
          { progressIncrement: 1 },
          deps,
        );
        await emitCheckpoint();
      } catch (error) {
        if (error?.kind === "rate_limit" || RATE_LIMIT_RE.test(error?.message ?? "")) {
          rateLimited = true;
          rateLimitError = error;
          failures[group.hash] = { label: group.labelRange, code: "RATE_LIMITED" };
          break;
        }
        await persistMapState();
      }
    }
    await persistMapState();
  }

  if (rateLimited) {
    throw new AiError(
      "rate_limit",
      "The AI service hit its rate limit or daily quota. Wait a few minutes and tap Try again — finished pages are kept.",
      { retryable: true, retryAfterMs: rateLimitError?.retryAfterMs ?? null },
    );
  }

  const failedRatio = groups.length ? Object.keys(failures).length / groups.length : 0;
  if (failedRatio > longDoc.maxFailedChunkRatio) {
    throw new UserFacingError(
      "Too many parts of this file could not be processed. Tap Try again, or upload it by chapter.",
    );
  }
  const lost = Object.values(failures)
    .map((failure) => failure.label)
    .filter(Boolean);
  return { digests: saved, failures, lost, calls, failedRatio };
}

// ---------------------------------------------------------------------------
// Reduce (3.6)
// ---------------------------------------------------------------------------

function mergeModel() {
  return strongModel() === bulkModel() ? bulkModel() : strongModel();
}

/**
 * Split merge inputs into waves whose serialised payload fits the merge
 * prompt budget. Count-based slicing used to overflow REDUCE_MAX_CHARS on
 * large sources and the payload was then sliced mid-JSON — invalid input.
 * Waves are capped by both payload size and REDUCE_GROUP_SIZE.
 */
export function partitionWaves(items, maxChars) {
  const budget = Math.max(1_000, Math.floor(maxChars * 0.85));
  // Two caps, both needed: payload size keeps the request inside the model's
  // context, item count keeps one request short enough to finish inside a
  // runner pass. Without the item cap a dense document produced waves of ten
  // digests whose single merge call could outlive the whole pass.
  const maxItems = Math.max(2, Math.min(longDoc.reduceGroupSize, longDoc.reduceBatchItems));
  const waves = [];
  let wave = [];
  let chars = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length + 1;
    const full = wave.length && (chars + size > budget || wave.length >= maxItems);
    if (full) {
      waves.push(wave);
      wave = [];
      chars = 0;
    }
    wave.push(item);
    chars += size;
  }
  if (wave.length) waves.push(wave);
  return waves;
}

/**
 * Last-resort compaction for a single digest too big for any wave: drop the
 * optional fields first, then shorten point lists. Output stays valid JSON —
 * unlike slicing the serialised payload.
 */
function slimDigest(digest, budget) {
  const copy = JSON.parse(JSON.stringify(digest));
  const fits = () => JSON.stringify(copy).length <= budget;
  if (fits()) return copy;
  for (const topic of copy.topics ?? []) {
    topic.examples = [];
    topic.emphasised = [];
    if (fits()) return copy;
  }
  for (const cut of [8, 5, 3]) {
    for (const topic of copy.topics ?? []) {
      topic.points = (topic.points ?? []).slice(0, cut);
    }
    if (fits()) return copy;
  }
  copy.unclear = [];
  for (const topic of copy.topics ?? []) {
    topic.terms = (topic.terms ?? []).slice(0, 5);
    topic.formulas = (topic.formulas ?? []).slice(0, 5);
  }
  return copy;
}

class ReduceSplitError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReduceSplitError";
    this.splittable = true;
  }
}

/**
 * A merge returns roughly the same shape it receives, so the wave must fit the
 * model's OUTPUT budget as well as REDUCE_MAX_CHARS. At ~4 chars/token and an
 * 8192-token cap, half the budget is a safe expected output; the rest is
 * headroom for prompt overhead and JSON structure.
 */
function reduceBudget(promptChars = 0) {
  const fromChars = Math.floor(longDoc.reduceMaxChars * 0.85);
  const fromTokens = Math.floor(notePipeline.studySetMaxTokens * 4 * 0.55);
  return Math.max(4_000, Math.min(fromChars, fromTokens) - Math.max(0, promptChars));
}

function reduceWaveKey(scope, level, items, model) {
  // The batch id is derived from what is being merged, never from its position
  // in the wave list: a resume that repartitions (because a digest landed late)
  // still finds every merge it already paid for, and two identical waves at one
  // level collapse onto the same key instead of being merged twice.
  return `${scope}:L${level}:B${stableBatchId(scope, level, items)}:${PROMPT_VERSION}:${model}`;
}

/** Stable identifier of one merge operation: scope + level + member content. */
export function stableBatchId(scope, level, items) {
  const members = (items ?? []).map((item) => sha1(JSON.stringify(item ?? null)).slice(0, 12));
  return sha1(`${scope}|L${level}|${members.join(",")}`).slice(0, 16);
}

/** Section summary key: a finished section is skipped entirely on a resume. */
function sectionSummaryKey(section, items) {
  return `sectionDone:${section.id}:B${stableBatchId(`section:${section.id}`, 0, items)}`;
}

// ---------------------------------------------------------------------------
// Merge execution budget
//
// One runner pass is a fixed wall clock (a Vercel invocation). A merge that
// starts with less than a full window left is clamped by the deadline, times
// out, and spends an attempt instead of parking the job — so the pass ends by
// itself, at a safe boundary, leaving time to persist and release.
// ---------------------------------------------------------------------------

function remainingBudget(deps) {
  if (!deps?.deadline) return Infinity;
  return deps.deadline - Date.now();
}

/** How long one merge request may take, never past this pass's deadline. */
function mergeTimeoutFor(deps) {
  const remaining = remainingBudget(deps) - longDoc.reduceReserveMs;
  if (!Number.isFinite(remaining)) return longDoc.mergeTimeoutMs;
  return Math.max(5_000, Math.min(longDoc.mergeTimeoutMs, remaining));
}

/**
 * Throw a yield unless a merge can plausibly finish and be persisted inside
 * this pass. Called before every model request and before every retry.
 */
function ensureMergeWindow(deps, log, reason = "budget") {
  const remaining = remainingBudget(deps);
  const needed = longDoc.reduceMinWindowMs + longDoc.reduceReserveMs;
  if (remaining >= needed) return;
  const remainingMs = Number.isFinite(remaining) ? Math.max(0, Math.round(remaining)) : Infinity;
  console.log(
    `[reduce] yield job=${log?.jobId ?? "-"} stage=merging scope=${log?.scope ?? "-"} level=${log?.level ?? "-"} batch=${log?.batch ?? "-"} reason=${reason} remainingMs=${remainingMs} needMs=${needed}`,
  );
  throw new JobYieldError("merging", {
    detail: `scope=${log?.scope ?? "-"} level=${log?.level ?? "-"} batch=${log?.batch ?? "-"} remainingMs=${remainingMs} needMs=${needed}`,
  });
}

/**
 * A transient provider failure is worth one more attempt. Rate limits are
 * parked by the pipeline (they are project-wide, so retrying immediately is
 * pointless), and auth/quota/bad-request are permanent configuration errors
 * that must not be retried at all.
 */
function isRetryableMergeError(error) {
  const kind = error?.kind;
  if (kind === "transient" || kind === "timeout") return true;
  if (kind) return false;
  return isTransientNetworkError(error);
}

function isTransientNetworkError(error) {
  const code = error?.code;
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EAI_AGAIN") {
    return true;
  }
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("fetch failed") || message.includes("socket hang up");
}

function isSplittableReduceError(error) {
  if (!error) return false;
  if (error.splittable) return true;
  if (error.kind === "too_large" || error.kind === "invalid_output") return true;
  return /validation|unparseable|code fence|json/i.test(String(error.message ?? ""));
}

/**
 * Whether a merge failure may be answered from local material. These say "this
 * request or response was too big, too slow or too badly shaped", not "your key
 * or your account is wrong": the latter must fail the job rather than quietly
 * writing a note the student believes is complete.
 */
function isDegradableReduceError(error) {
  if (!error || error.yield || error.cancelled) return false;
  if (isUserFacing(error)) return false;
  const kind = error?.kind;
  if (
    kind === "auth" ||
    kind === "quota" ||
    kind === "bad_request" ||
    kind === "rate_limit" ||
    kind === "checkpoint_write"
  ) {
    return false;
  }
  if (kind) return true;
  return isSplittableReduceError(error) || error?.name === "ReduceSplitError";
}

/**
 * Persist one merge result by path instead of rewriting the whole reduce map.
 *
 * The write is durable or it throws: a merge whose result is still only in
 * memory is not finished, and pretending otherwise is what made a long document
 * re-merge the same waves on every pass. Returns the value the row holds, which
 * may be a newer one another attempt persisted first.
 */
async function patchReduceEntry(job, key, value, deps) {
  const started = Date.now();
  try {
    if (deps.saveReduceEntry) {
      await deps.saveReduceEntry(key, value);
      await deps.onCheckpoint?.({ reduce: { [key]: value } });
      return value;
    }
    const written = await writeCheckpointEntry(job.id, "reduce", key, value);
    await deps.onCheckpoint?.({ reduce: { [key]: written.value } });
    if (!written.stored) {
      console.log(
        `[reduce] checkpoint kept existing batch job=${job.id} batch=${batchLabel(key)} adopting=${written.value === value ? "same" : "newer"}`,
      );
    }
    return written.value ?? value;
  } catch (error) {
    console.warn(
      `[reduce] checkpoint write failed job=${job.id} batch=${batchLabel(key)} ms=${Date.now() - started} code=${error?.kind ?? error?.name ?? "error"}`,
    );
    if (error instanceof CheckpointWriteError) throw error;
    throw new CheckpointWriteError(
      `reduce checkpoint write failed for job ${job.id}: ${error?.message ?? error}`,
      { jobId: job.id, path: `reduce.${batchLabel(key)}`, cause: error },
    );
  }
}

/** Short, log-safe label for a checkpoint key (scope + batch id only). */
function batchLabel(key) {
  const parts = String(key ?? "").split(":");
  const batch = parts.find((part) => /^B[0-9a-f]{8,}$/.test(part)) ?? sha1(key ?? "").slice(0, 8);
  return `${parts[0] ?? "?"}/${batch}`;
}

/**
 * Merge several digests into one summary of the same shape. One bounded
 * transient retry (5xx/timeout) with backoff, then a stricter temperature-0
 * repair pass for an unusable shape, then a split signal for the hierarchy.
 * Inputs are wave-sized by partitionWaves; a lone oversized digest is compacted
 * (slimDigest), never truncated.
 */
async function mergeDigests({ digests, prompt, step, deps, log = null }) {
  const budget = reduceBudget(prompt.length);
  let payload = JSON.stringify(digests);
  if (payload.length > budget) {
    const share = Math.floor(budget / Math.max(1, digests.length));
    payload = JSON.stringify(digests.map((digest) => slimDigest(digest, share)));
  }
  // Last guard before the request goes out: an oversized payload is answered by
  // splitting the wave (the hierarchy), never by sending it and hoping the
  // provider keeps up. Slicing the JSON is still forbidden — it would corrupt
  // the input.
  if (payload.length > longDoc.mergePayloadMaxChars) {
    throw new ReduceSplitError(
      `Merge payload of ${payload.length} chars exceeds ${longDoc.mergePayloadMaxChars}`,
    );
  }
  let attempts = 0;
  const call = async (stricter, cutOff) => {
    for (;;) {
      attempts += 1;
      const started = Date.now();
      try {
        const result = await chatCompletion({
          system:
            "You merge structured study material for a university student revising for exams. " +
            "Output ONLY valid JSON matching the requested shape — no prose, no code fences." +
            (stricter ? " Schema exactly as instructed. No extra keys." : ""),
          user:
            `${prompt}\n\n` +
            (cutOff
              ? "Your previous answer was cut off. Return a shorter JSON object: at most 6 topics, at most 5 points per topic.\n\n"
              : "") +
            `=== DIGESTS ===\n${payload}`,
          model: mergeModel(),
          json: true,
          temperature: stricter ? 0 : 0.2,
          maxTokens: notePipeline.studySetMaxTokens,
          timeoutMs: mergeTimeoutFor(deps),
        });
        await deps.record(stricter ? `${step}_retry` : step, result);
        if (log) {
          console.log(
            `[reduce] merge job=${log.jobId} stage=merging scope=${log.scope} level=${log.level} batch=${log.batch} model=${result.model ?? mergeModel()} items=${digests.length} chars=${payload.length} ms=${Date.now() - started} attempt=${attempts}`,
          );
        }
        return result;
      } catch (error) {
        await deps.recordFailure?.(step, error, Date.now() - started);
        console.warn(
          `[reduce] merge failed job=${log?.jobId ?? "-"} stage=merging scope=${log?.scope ?? "-"} level=${log?.level ?? "-"} batch=${log?.batch ?? "-"} model=${mergeModel()} items=${digests.length} ms=${Date.now() - started} attempt=${attempts} code=${error?.kind ?? error?.name ?? "error"} status=${Number.isFinite(error?.status) ? error.status : "-"}`,
        );
        if (!isRetryableMergeError(error) || attempts >= Math.max(1, longDoc.mergeAttempts)) {
          throw error;
        }
        // A retry that cannot finish inside this pass is a yield, not a
        // failure: nothing is lost and the wave resumes next pass without
        // spending one of the job's attempts.
        ensureMergeWindow(deps, log, "retry");
        // Harnesses shorten this; production keeps a 1.5s×attempt backoff so a
        // provider flap clears without a hot retry loop.
        const backoff = Math.max(0, deps.mergeRetryDelayMs ?? 1_500) * attempts;
        if (log) {
          console.log(
            `[reduce] merge retry job=${log.jobId} batch=${log.batch} attempt=${attempts + 1} backoffMs=${backoff} code=${error?.kind ?? "error"}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  };
  const attemptOutcome = async (stricter, cutOff = false) => {
    const result = await call(stricter, cutOff);
    const parsed = parseJsonObject(result.text);
    const problem = parsed ? validateDigest(parsed) : "unparseable JSON";
    const endedCleanly = /\}\s*$/.test(String(result.text).trim());
    if (problem) {
      console.warn(
        `[reduce] merge invalid job=${log?.jobId ?? "-"} batch=${log?.batch ?? "-"} attempt=${attempts} repair=${stricter ? "final" : "retry"} reason=${String(problem).slice(0, 80)}`,
      );
    }
    return { parsed, problem, cutOff: Boolean(problem) && !endedCleanly };
  };
  let outcome = await attemptOutcome(false);
  if (outcome.problem) outcome = await attemptOutcome(true, outcome.cutOff);
  if (outcome.problem) throw new ReduceSplitError(`Merge failed validation (${outcome.problem})`);
  const digest = {
    range: String(outcome.parsed.range ?? ""),
    topics: outcome.parsed.topics.map((topic) => ({
      heading: String(topic?.heading ?? "").trim() || "Untitled topic",
      points: (topic?.points ?? []).map(String),
      terms: (topic?.terms ?? []).map((term) => ({
        term: String(term?.term ?? "").trim(),
        definition: String(term?.definition ?? "").trim(),
      })),
      formulas: (topic?.formulas ?? []).map((formula) => ({
        expression: String(formula?.expression ?? "").trim(),
        symbols: (formula?.symbols ?? []).map((symbol) => ({
          symbol: String(symbol?.symbol ?? ""),
          meaning: String(symbol?.meaning ?? "").trim(),
          unit: String(symbol?.unit ?? ""),
        })),
        context: String(formula?.context ?? ""),
      })),
      examples: (topic?.examples ?? []).map(String),
      emphasised: (topic?.emphasised ?? []).map(String),
      source: String(topic?.source ?? ""),
    })),
    unclear: (outcome.parsed.unclear ?? []).slice(0, 20).map(String),
  };
  // Output side of the budget: a merge must not hand the next level a payload
  // as large as the one it received, or the hierarchy never converges.
  const shrunk = shrinkMergedDigest(digest, payload.length);
  if (log && shrunk.topics.length !== digest.topics.length) {
    console.warn(`[reduce] merge lost topics job=${log.jobId} batch=${log.batch}`);
  }
  return { digest: shrunk, inputChars: payload.length, attempts };
}

/**
 * Compact a merge result so a level always shrinks the hierarchy, while every
 * topic heading, term and formula survives: section boundaries and technical
 * content are what make the note usable, so the optional prose goes first.
 */
export function shrinkMergedDigest(digest, inputChars) {
  const target = Math.max(
    1_500,
    Math.min(
      Math.floor(Number(inputChars || 0) * longDoc.mergeShrinkRatio),
      reduceBudget(0),
    ),
  );
  const copy = {
    ...digest,
    topics: (digest?.topics ?? []).map((topic) => ({
      ...topic,
      points: [...(topic.points ?? [])],
      terms: [...(topic.terms ?? [])],
      formulas: [...(topic.formulas ?? [])],
      examples: [...(topic.examples ?? [])],
      emphasised: [...(topic.emphasised ?? [])],
    })),
  };
  const fits = () => JSON.stringify(copy).length <= target;
  if (fits() || !copy.topics.length) return copy;

  // 1. Optional colour first: examples and bold-emphasis carry no facts.
  for (const topic of copy.topics) {
    topic.examples = [];
    topic.emphasised = [];
  }
  if (fits()) return copy;

  // 2. Long point lists, shortest survivors kept at one each so no topic
  //    disappears from the outline.
  for (const cap of [6, 4, 3, 2]) {
    for (const topic of copy.topics) topic.points = topic.points.slice(0, cap);
    if (fits()) return copy;
  }
  for (const topic of copy.topics) topic.points = topic.points.slice(0, 1);

  // 3. Open questions and the per-topic source line are the last to go.
  copy.unclear = [];
  for (const topic of copy.topics) {
    topic.source = "";
    topic.terms = topic.terms.slice(0, 6);
    topic.formulas = topic.formulas.slice(0, 6);
  }
  return copy;
}

/**
 * Reduce a list of digest-shaped items to ONE summary through as many levels as
 * needed. A wave is either merged, taken as-is when it has a single item, or
 * split (with the children cached) when the provider rejects its size/output.
 */
async function reduceLevel({
  items,
  level,
  scope,
  sourceType,
  courseContext,
  deps,
  job,
  saved,
  promptFor,
  stepFor = null,
  depth = 0,
}) {
  const list = items.filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  if (depth > 8 || level > 16) {
    // The provider cannot merge even two small items. Concatenating preserves
    // every fact and lets the caller continue; failing here would lose a
    // complete document to one stubborn response.
    return list.reduce((acc, item) => (acc ? mergeSummaries(acc, item) : item), null);
  }

  const model = mergeModel();
  let waves = partitionWaves(list, reduceBudget());
  // Every item can exceed the wave budget (dense digests). Returning them as
  // single-item waves would never shrink the list, so force pairs; mergeDigests
  // compacts each payload with slimDigest instead of slicing JSON.
  if (waves.length > 1 && waves.every((wave) => wave.length === 1)) {
    waves = [];
    for (let index = 0; index < list.length; index += 2) {
      waves.push(list.slice(index, index + 2));
    }
  }
  const total = waves.length;
  const results = [];

  for (const [index, wave] of waves.entries()) {
    if (!wave.length) continue;
    if (wave.length === 1) {
      results.push(wave[0]);
      await deps.setStage("merging", { done: index + 1, total });
      continue;
    }
    const key = reduceWaveKey(scope, level, wave, model);
    const batch = stableBatchId(scope, level, wave);
    const log = { jobId: job.id, scope, level, batch, index, total };
    let result = saved[key];
    if (!result) {
      // Check the pass budget BEFORE spending a request: a merge that starts
      // with no window left is clamped to the deadline, times out, and burns an
      // attempt instead of parking finished work.
      ensureMergeWindow(deps, log);
      const prompt = promptFor(index, total, level);
      const step = stepFor ? stepFor(level, index) : level === 0 ? "reduce" : "reduce_wave";
      try {
        const merged = await withStage(deps, "merging", () =>
          mergeDigests({ digests: wave, prompt, step, deps, log }),
        );
        result = merged.digest;
      } catch (error) {
        if (error?.yield || error?.cancelled) throw error;
        if (!isSplittableReduceError(error) || wave.length < 2) throw error;
        console.warn(
          `[reduce] split job=${job.id} scope=${scope} level=${level} batch=${batch} items=${wave.length} code=${error?.kind ?? error?.name ?? "error"}`,
        );
        const mid = Math.ceil(wave.length / 2);
        const left = await reduceLevel({
          items: wave.slice(0, mid),
          level: level + 1,
          scope: `${scope}:S${batch}a`,
          sourceType,
          courseContext,
          deps,
          job,
          saved,
          promptFor,
          stepFor,
          depth: depth + 1,
        });
        const right = await reduceLevel({
          items: wave.slice(mid),
          level: level + 1,
          scope: `${scope}:S${batch}b`,
          sourceType,
          courseContext,
          deps,
          job,
          saved,
          promptFor,
          stepFor,
          depth: depth + 1,
        });
        result =
          left && right
            ? await reduceLevel({
                items: [left, right],
                level: level + 1,
                scope: `${scope}:S${batch}m`,
                sourceType,
                courseContext,
                deps,
                job,
                saved,
                promptFor,
                stepFor,
                depth: depth + 1,
              })
            : (left ?? right);
      }
      if (result) {
        // Durable or throw: `saved` only ever holds what the row holds, so a
        // resumed pass cannot mistake an unwritten merge for finished work.
        result = await patchReduceEntry(job, key, result, deps);
        saved[key] = result;
      }
    }
    results.push(result);
    await deps.setStage("merging", { done: index + 1, total });
  }

  // One wave covers the level. More than one needs another level.
  return reduceLevel({
    items: results,
    level: level + 1,
    scope,
    sourceType,
    courseContext,
    deps,
    job,
    saved,
    promptFor,
    stepFor,
    depth,
  });
}

/**
 * Group digests by outline section, reduce each section hierarchically, then
 * reduce the section summaries into ONE document overview. Every successful
 * wave is checkpointed under a stable key, so a resumed pass pays only for the
 * waves that have not finished yet.
 */
export async function reduceDigests({ job, digests, groups, sections, sourceType, courseContext, deps }) {
  // The job row, not the snapshot this pass was claimed with, is the source of
  // truth for finished merges: a resume (or a second attempt that already
  // advanced the checkpoint) must never re-pay for a wave the row holds.
  // A harness that keeps its own reduce store (`saveReduceEntry`) is the same
  // source of truth, so it is not read twice.
  const fresh = deps?.saveReduceEntry ? null : await readJobCheckpoint(job.id).catch(() => null);
  const saved = { ...(job.checkpoint?.reduce ?? {}), ...(fresh?.reduce ?? {}) };
  const digestKey = (group) => digestCacheKey(group, bulkModel());
  const summariesFor = {};
  const degraded = [];
  let firstDegradation = null;
  let sectionsWithEntries = 0;

  const sectionPrompt = (index, count) =>
    reducePrompt({ course: courseContext, sourceType, groupIndex: index, groupCount: count });

  /**
   * Section-level fallback: a section whose merge cannot be produced by the
   * model is folded locally (no request, nothing lost — every topic, point,
   * term and formula of the digests survives) and the note says so. A permanent
   * configuration error is NOT degraded: it fails the job instead of shipping a
   * note that pretends to be complete.
   */
  const localSummary = (entries) =>
    entries.reduce((acc, entry) => (acc ? mergeSummaries(acc, entry) : entry), null);

  for (const section of sections) {
    const entries = groups
      .filter((group) => group.sectionId === section.id)
      .map((group) => digests[digestKey(group)])
      .filter(Boolean);
    if (!entries.length) continue;
    sectionsWithEntries += 1;

    // A finished section is skipped without a single call: its summary was
    // persisted under a content-derived key, so a resume never re-merges it.
    const doneKey = sectionSummaryKey(section, entries);
    let summary = saved[doneKey];
    if (!summary) {
      try {
        summary = await reduceLevel({
          items: entries,
          level: 0,
          scope: `section:${section.id}`,
          sourceType,
          courseContext,
          deps,
          job,
          saved,
          promptFor: sectionPrompt,
          stepFor: (level) => (level === 0 ? "reduce" : "reduce_wave"),
        });
      } catch (error) {
        if (error?.yield || error?.cancelled || !isDegradableReduceError(error)) throw error;
        summary = localSummary(entries);
        degraded.push(section.title || section.id);
        firstDegradation = firstDegradation ?? error;
        console.warn(
          `[reduce] section degraded job=${job.id} section=${section.id} items=${entries.length} code=${error?.kind ?? error?.name ?? "error"}`,
        );
      }
      if (summary) {
        summary = await patchReduceEntry(job, doneKey, summary, deps);
        saved[doneKey] = summary;
      }
    }
    if (summary) summariesFor[section.id] = { summary, section };
  }

  const summaryList = Object.values(summariesFor);
  // A degraded section is a partial answer. If the model could not merge the
  // document at all (every section, or more than the allowed share), this is
  // not "some parts were merged locally" — it is a broken provider, and the
  // job must retry instead of shipping a note that looks complete.
  if (degraded.length && sectionsWithEntries) {
    const share = degraded.length / sectionsWithEntries;
    if (share > longDoc.maxDegradedSectionShare) {
      console.warn(
        `[reduce] too many degraded sections job=${job.id} degraded=${degraded.length}/${sectionsWithEntries} code=${firstDegradation?.kind ?? firstDegradation?.name ?? "error"}`,
      );
      throw firstDegradation ?? new Error("The AI could not merge this document");
    }
  }
  // The overview belongs to the summaries it was built from: a section that
  // changed (or landed late) produces a different key, so a stale overview can
  // never be reused for a different document state.
  const overviewKey = summaryList.length
    ? `overview:${stableBatchId("overview", 0, summaryList.map((item) => item.summary))}:${PROMPT_VERSION}:${mergeModel()}`
    : null;
  let overview = overviewKey ? saved[overviewKey] : null;
  if (!overview && summaryList.length) {
    const overviewPromptFor = (index, count, level) =>
      level === 0
        ? overviewPrompt({ course: courseContext, sourceType, sectionCount: summaryList.length })
        : reducePrompt({ course: courseContext, sourceType, groupIndex: index, groupCount: count });
    try {
      overview = await reduceLevel({
        items: summaryList.map((item) => item.summary),
        level: 0,
        scope: "overview",
        sourceType,
        courseContext,
        deps,
        job,
        saved,
        promptFor: overviewPromptFor,
        stepFor: (level) => (level === 0 ? "overview" : "overview_wave"),
      });
    } catch (error) {
      if (error?.yield || error?.cancelled || !isDegradableReduceError(error)) throw error;
      overview = summaryList
        .map((item) => item.summary)
        .reduce((acc, item) => (acc ? mergeSummaries(acc, item) : item), null);
      degraded.push("Overview");
      console.warn(
        `[reduce] overview degraded job=${job.id} sections=${summaryList.length} code=${error?.kind ?? error?.name ?? "error"}`,
      );
    }
    if (overview) {
      overview = await patchReduceEntry(job, overviewKey, overview, deps);
      saved[overviewKey] = overview;
    }
  }

  return { summariesFor, summaryList, overview, degraded };
}

function withStage(deps, stage, fn) {
  return (async () => {
    await deps.setStage(stage);
    return fn();
  })();
}

function mergeSummaries(base, next) {
  return {
    range: [base.range, next.range].filter(Boolean).join(", "),
    topics: [...(base.topics ?? []), ...(next.topics ?? [])],
    unclear: [...(base.unclear ?? []), ...(next.unclear ?? [])],
  };
}

// ---------------------------------------------------------------------------
// Generate (3.7)
// ---------------------------------------------------------------------------

/** Scaled limits for single-mode long notes (sampled evenly at call time). */
export function buildStudyPackSchema(spec) {
  return spec;
}

function scaledSpec(sectionsCount) {
  const count = Math.max(3, sectionsCount);
  return {
    keyTerms: [8, Math.min(30, 10 + count)],
    examQuestions: [4, Math.min(15, 5 + Math.floor(count / 2))],
    flashcards: [12, Math.min(60, 16 + count * 3)],
    quiz: [8, Math.min(20, 8 + Math.floor(count / 2))],
  };
}

function scaledStudySetPrompt({ courseContext, spec }) {
  const cardTarget = spec.flashcards[1];
  return `Lecture course context: ${courseContext}
This study pack covers a LONG document (many sections). Sample evenly through ALL of the
material — beginning, middle and end — never just the start.
From the lecture material below, produce a complete university study pack conforming to this JSON specification:
{
  "shortSummary": "A 6-10 sentence overview of the whole material.",
  "keyTerms": [{ "term": "key term name", "definition": "concise, accurate definition" }],
  "formulas": ["relevant equations, or empty array [] if none exist"],
  "examQuestions": ["likely exam or tutorial questions based strictly on the content"],
  "flashcards": [{ "front": "Active recall question", "back": "Concise, complete answer" }],
  "quiz": [{
    "type": "mcq",
    "prompt": "Question prompt",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "answer": "Exact text of the correct option",
    "explanation": "One sentence explaining why."
  }]
}
Rules:
- shortSummary: 6-10 sentences covering the whole document.
- keyTerms: ${spec.keyTerms[0]}-${spec.keyTerms[1]} terms with definitions, sampled evenly across sections.
- formulas: relevant formulas/equations from anywhere in the material, or [] if none exist.
- examQuestions: ${spec.examQuestions[0]}-${spec.examQuestions[1]} likely exam questions.
- flashcards: ${cardTarget} active recall cards, sampled evenly across sections.
- quiz: ${spec.quiz[0]}-${spec.quiz[1]} multiple-choice questions, 4 options each, exact matching answer, one-sentence explanation.
- Use only what the lecture material teaches. Do not fabricate.
Return ONLY the JSON object.`;
}

/**
 * One study-pack call with the given material and (scaled or normal) limits,
 * validated with the shared validator, one temperature-0 repair pass.
 */
async function generateStudySetForMaterial({ material, courseContext, spec, deps }) {
  const prompt = spec
    ? scaledStudySetPrompt({ courseContext, spec })
    : `Lecture course context: ${courseContext}
From the lecture material below, produce a complete university study pack conforming to this JSON specification:
{
  "shortSummary": "A 4-6 sentence clear, high-yield overview of the material.",
  "keyTerms": [{ "term": "key term name", "definition": "concise, accurate definition" }],
  "formulas": ["relevant equations, or empty array [] if none exist"],
  "examQuestions": ["3-6 likely exam questions based strictly on the content"],
  "flashcards": [{ "front": "Active recall question", "back": "Concise, complete answer" }],
  "quiz": [{ "type": "mcq", "prompt": "Question", "options": ["A","B","C","D"], "answer": "Exact correct option", "explanation": "One sentence." }]
}
Rules:
- shortSummary: 4-6 sentences.
- keyTerms: 5-10 terms with definitions.
- formulas: relevant formulas, or [] if none.
- examQuestions: 3-6 likely exam questions.
- flashcards: 8-20 active recall cards.
- quiz: 5-8 multiple-choice questions, 4 options each, exact matching answer, one-sentence explanation.
- Use only the lecture material. Do not fabricate. Cite the page or slide range in brackets (for example (p. 12), (Slide 4-6), (about 12:30)) at the end of key definitions and exam questions when the material has labeled sources.
Return ONLY the JSON object.`;

  const attempt = async (stricter) => {
    const step = stricter ? "generate_study_set_retry" : "generate_study_set";
    const started = Date.now();
    let result;
    try {
      result = await chatCompletion({
        system: stricter
          ? "You are Sua. Output ONLY valid JSON matching the requested study pack schema exactly — no prose, no code fences."
          : "You are Sua, an exam-focused study assistant for African university students. Use only the material provided. Write clearly in simple English. Output only valid JSON.",
        user: `${prompt}\n\n=== LECTURE MATERIAL ===\n${material}`,
        model: bulkModel(),
        json: true,
        maxTokens: notePipeline.studySetMaxTokens,
        temperature: stricter ? 0 : 0.2,
        timeoutMs: timeoutForDeadline(deps.deadline),
      });
    } catch (error) {
      await deps.recordFailure?.(step, error, Date.now() - started);
      throw error;
    }
    await deps.record(step, result);
    const parsed = parseJsonObject(result.text);
    return parsed;
  };

  // Validate here (same shape the shared validator expects) with a repair pass.
  let parsed = await attempt(false);
  let validation = validateStudyPack(parsed);
  if (!validation.success) {
    parsed = await attempt(true);
    validation = validateStudyPack(parsed);
    if (!validation.success) {
      throw new UserFacingError(
        `Generated study pack failed validation (${validation.error}). Tap Try again.`,
      );
    }
  }
  const set = validation.data;
  set.summaryMarkdown = summaryToMarkdown(set);
  return set;
}

function summaryToMarkdown(pack) {
  const lines = ["## Overview", String(pack.shortSummary ?? "").trim(), ""];
  if (pack.keyTerms?.length) {
    lines.push("## Key Terms");
    for (const term of pack.keyTerms) lines.push(`- **${term.term}** — ${term.definition}`);
    lines.push("");
  }
  if (pack.formulas?.length) {
    lines.push("## Formulas & Examples");
    for (const item of pack.formulas) lines.push(`- ${item}`);
    lines.push("");
  }
  if (pack.examQuestions?.length) {
    lines.push("## Likely Exam Questions");
    for (const [index, question] of pack.examQuestions.entries()) lines.push(`${index + 1}. ${question}`);
  }
  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Sectioned single-note writer (long files)
// ---------------------------------------------------------------------------

const WRITE_MAX_CHARS = 40_000;

function cleanHeading(value) {
  return String(value ?? "")
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Canonical, globally unique `##` titles (Overview/Key Takeaways reserved). */
function uniqueHeadings(titles) {
  const reserved = new Set(["overview", "key takeaways"]);
  const used = new Set();
  return titles.map((raw, index) => {
    const base = cleanHeading(raw) || `Section ${index + 1}`;
    let title = base;
    let suffix = 2;
    while (reserved.has(title.toLowerCase()) || used.has(title.toLowerCase())) {
      title = `${base} (${suffix})`;
      suffix += 1;
    }
    used.add(title.toLowerCase());
    return title;
  });
}

function pagesForRows(rows) {
  const labels = rows.map((row) => row.label).filter(Boolean);
  if (labels.length) return rangeLabel(labels);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const start = first?.startPage ?? first?.index;
  const end = last?.endPage ?? last?.startPage ?? last?.index;
  if (!start) return "";
  return end && end !== start ? `p. ${start}-${end}` : `p. ${start}`;
}

/** Evenly sample whole pages so the writer still sees the whole section. */
function sampleRows(rows, maxChars) {
  const out = [];
  let used = 0;
  const step = Math.max(1, Math.ceil(rows.length / 40));
  for (let index = 0; index < rows.length && used < maxChars; index += step) {
    const text = String(rows[index]?.text ?? "").trim();
    if (!text) continue;
    const room = maxChars - used;
    if (room < 200) break;
    const slice = text.slice(0, room);
    out.push(slice);
    used += slice.length + 2;
  }
  return out.join("\n\n");
}

function buildSectionMaterial({ rows, summaryText, maxChars }) {
  const raw = rows.map((row) => row.text ?? "").join("\n\n");
  if (!raw) return { material: String(summaryText ?? "").slice(0, maxChars), sampled: false };
  if (raw.length <= maxChars) return { material: raw, sampled: false };
  // Too much raw text: keep the reduced summary, then fill the remaining
  // budget with evenly sampled pages. Never slice JSON mid-object.
  const summaryBudget = Math.max(800, Math.floor(maxChars * 0.55));
  let material = String(summaryText ?? "").slice(0, summaryBudget).trim();
  const excerptBudget = maxChars - material.length - 60;
  if (excerptBudget > 400) {
    const excerpts = sampleRows(rows, excerptBudget);
    if (excerpts) {
      material = material ? `${material}\n\n=== SOURCE EXCERPTS ===\n${excerpts}` : excerpts;
    }
  }
  if (!material) material = raw.slice(0, maxChars);
  return { material, sampled: true };
}

function sectionBudget(kind, pagesUsed, writeCount) {
  const total =
    kind === "course_reference"
      ? Math.min(
          longDoc.referenceBodyMaxWords,
          Math.max(notePipeline.referenceMaxWords, Math.ceil(Math.max(1, pagesUsed) / 8) * 100),
        )
      : Math.max(1200, Math.floor(longDoc.noteBodyMaxWords * 0.75));
  const min = kind === "course_reference" ? longDoc.referenceSectionWordsMin : longDoc.sectionWordsMin;
  const max = kind === "course_reference" ? longDoc.referenceSectionWordsMax : longDoc.sectionWordsMax;
  return Math.max(min, Math.min(max, Math.floor(total / Math.max(1, writeCount))));
}

/**
 * Plan the section-body writes. One write per outline section; very
 * fragmented outlines are packed into at most `maxSectionWrites` writes.
 * Titles prefer real outline headings and fall back to the reduced topic
 * heading, so generic "Section N" windows still get meaningful pages.
 */
export function planSectionWrites({
  sections,
  summaryList,
  groups,
  kind,
  pagesUsed,
  defaultTitle = "Study notes",
}) {
  const summaries = new Map(summaryList.map((item) => [item.section?.id, item]));
  const usable = sections.filter((section) => groups.some((group) => group.sectionId === section.id));
  if (!usable.length) return [];

  const rawTitles = usable.map((section, index) => {
    const summary = summaries.get(section.id)?.summary;
    const outline = cleanHeading(section.title);
    const generic = !outline || /^section\s+\d+$/i.test(outline);
    if (!generic) return outline;
    const topic = cleanHeading(summary?.topics?.[0]?.heading);
    return topic || outline || (sections.length === 1 ? defaultTitle : `Section ${index + 1}`);
  });
  const titles = uniqueHeadings(rawTitles);
  const perWrite = Math.max(1, Math.ceil(usable.length / Math.max(1, longDoc.maxSectionWrites)));
  const rawWrites = [];

  for (let start = 0; start < usable.length; start += perWrite) {
    const chunk = usable.slice(start, start + perWrite);
    const chunkTitles = titles.slice(start, start + perWrite);
    const chunkGroups = chunk.flatMap((section) =>
      groups.filter((group) => group.sectionId === section.id),
    );
    const rows = chunkGroups.flatMap((group) => group.rows);
    const summaryText = chunk
      .map((section) => {
        const summary = summaries.get(section.id)?.summary;
        return summary ? digestToText(summary) : "";
      })
      .filter(Boolean)
      .join("\n\n");
    const { material, sampled } = buildSectionMaterial({
      rows,
      summaryText,
      maxChars: longDoc.sectionMaterialMaxChars,
    });
    rawWrites.push({
      sectionIds: chunk.map((section) => section.id),
      titles: chunkTitles,
      pages: chunk
        .map((section) =>
          pagesForRows(
            groups.filter((group) => group.sectionId === section.id).flatMap((group) => group.rows),
          ),
        )
        .filter(Boolean)
        .join("; "),
      material,
      rawText: clampChars(rows.map((row) => row.text ?? "").join("\n\n"), longDoc.maxSourceChars) || material,
      sampled,
      sectionHashes: chunkGroups.map((group) => group.hash),
    });
  }

  const maxWords = sectionBudget(kind, pagesUsed, rawWrites.length);
  return rawWrites.map((write, index) => ({
    ...write,
    index,
    sectionId: write.sectionIds.join("+"),
    maxWords,
    hash: sha1(`${write.sectionIds.join("|")}|${write.sectionHashes.join("|")}|${maxWords}`),
  }));
}

function demoteExtraHeadings(lines) {
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    const match = line.match(/^(#{1,2})(\s+.*)$/);
    return match ? `###${match[2]}` : line;
  });
}

/**
 * Guarantee the generated text contains exactly the requested `##` headings,
 * in order. Stray top-level headings are demoted to `###` so a section body
 * can never create an extra reading page; a missing heading is reported so
 * the caller can retry.
 */
export function enforceSectionHeadings(body, titles) {
  const cleanTitles = titles.map((title) => cleanHeading(title) || "Section");
  const titleKeys = cleanTitles.map((title) => title.toLowerCase());
  const lines = String(body ?? "").split("\n");
  const headings = [];
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = line.match(/^\s{0,3}(#{1,2})\s+(.*?)\s*#*\s*$/);
    if (!match) continue;
    const titleIndex = titleKeys.indexOf(cleanHeading(match[2]).toLowerCase());
    if (titleIndex >= 0 && !headings.some((heading) => heading.titleIndex === titleIndex)) {
      headings.push({ titleIndex, lineIndex: index });
    }
  }
  headings.sort((a, b) => a.lineIndex - b.lineIndex);
  const missing = cleanTitles.filter((_, index) => !headings.some((heading) => heading.titleIndex === index));

  const byTitle = new Map();
  for (const [index, heading] of headings.entries()) {
    const next = headings[index + 1]?.lineIndex ?? lines.length;
    byTitle.set(
      heading.titleIndex,
      demoteExtraHeadings(lines.slice(heading.lineIndex + 1, next)),
    );
  }

  if (!byTitle.size) {
    if (cleanTitles.length !== 1) return { body: "", missing };
    const cleaned = demoteExtraHeadings(lines).join("\n").trim();
    return {
      body: cleaned ? `## ${cleanTitles[0]}\n\n${cleaned}` : `## ${cleanTitles[0]}`,
      missing: [],
    };
  }

  const ordered = cleanTitles
    .map((title, titleIndex) => {
      const content = byTitle.get(titleIndex);
      if (!content) return "";
      const text = content.join("\n").trim();
      return text ? `## ${title}\n\n${text}` : `## ${title}`;
    })
    .filter(Boolean);

  const preamble = demoteExtraHeadings(
    lines.slice(0, headings.length ? headings[0].lineIndex : 0),
  )
    .join("\n")
    .trim();
  if (preamble && ordered.length) ordered[0] = `${ordered[0]}\n\n${preamble}`;
  return { body: ordered.join("\n\n"), missing };
}

function sectionProblems(body, maxWords) {
  const problems = [];
  if (/\$\$|\\frac|\\times|\\cdot|\\begin\{/.test(body)) problems.push("LaTeX");
  const words = String(body ?? "").split(/\s+/).filter(Boolean).length;
  if (words > Math.round(maxWords * 1.3)) problems.push(`over ${maxWords} words`);
  if (words < 20) problems.push("too short");
  return { problems, words };
}

async function writeSectionBody({ write, kind, courseContext, sourceType, deps }) {
  const system =
    kind === "course_reference"
      ? sectionReferencePrompt({
          course: courseContext,
          sourceType,
          titles: write.titles,
          pages: write.pages,
          maxWords: write.maxWords,
        })
      : sectionNotePrompt({
          course: courseContext,
          sourceType,
          titles: write.titles,
          pages: write.pages,
          maxWords: write.maxWords,
        });
  const step = kind === "course_reference" ? "reference_section_write" : "section_write";

  const attempt = async (suffix = "") => {
    const started = Date.now();
    let result;
    try {
      result = await chatCompletion({
        system,
        user: `${suffix ? `${suffix}\n\n` : ""}=== MATERIAL ===\n${write.material}`,
        model: strongModel(),
        temperature: suffix ? 0 : 0.2,
        maxTokens: notePipeline.writeMaxTokens,
        timeoutMs: timeoutForDeadline(deps.deadline),
      });
    } catch (error) {
      await deps.recordFailure?.(step, error, Date.now() - started);
      throw error;
    }
    await deps.record(suffix ? `${step}_retry` : step, result);
    const enforced = enforceSectionHeadings(result.text, write.titles);
    const structure = sectionProblems(enforced.body, write.maxWords);
    const fidelity = checkSourceFidelity({
      source: write.rawText,
      output: enforced.body,
      allow: courseContext,
    });
    const problems = [
      ...structure.problems,
      ...(enforced.missing.length ? [`missing heading(s): ${enforced.missing.join(", ")}`] : []),
      ...(fidelity.failed ? ["numbers/formulas not in source"] : []),
    ];
    return { body: enforced.body, problems, fidelity };
  };

  let outcome = await attempt();
  if (outcome.problems.length) {
    const suffix = [
      outcome.fidelity?.failed
        ? `Your previous answer contained numbers/formulas not in the source: ${outcome.fidelity.unsupportedFormulas
            .concat(outcome.fidelity.unsupportedNumbers)
            .slice(0, 12)
            .join(", ")}. Rewrite using only values that appear in the source.`
        : "",
      `Your previous answer had these problems: ${outcome.problems.join(", ")}. Fix them and return only the requested sections with the exact headings.`,
    ]
      .filter(Boolean)
      .join("\n");
    outcome = await attempt(suffix);
  }
  if (outcome.problems.length) {
    throw new Error(`Section write failed: ${outcome.problems.join(", ")}`);
  }
  return outcome.body;
}

async function persistSectionState(job, { saved, failures, calls }, progressIncrement, deps) {
  await patchCheckpoint(
    job.id,
    { sectionBodies: saved, sectionFailures: failures, sectionCalls: calls },
    { progressIncrement },
    deps,
  );
  await deps.onCheckpoint?.({
    sectionBodies: saved,
    sectionFailures: failures,
    sectionCalls: calls,
  });
}

/**
 * Write every planned section under bounded concurrency, checkpointing each
 * finished body. A resumed pass pays only for the sections it has not seen;
 * deadline exhaustion yields without failing the job.
 */
export async function writeSectionBodies({
  job,
  writes,
  kind,
  courseContext,
  sourceType,
  deps,
  onSaved = null,
}) {
  const model = strongModel();
  const keyFor = (write) => `${write.hash}:${SECTION_PROMPT_VERSION}:${model}`;
  const saved = { ...(job.checkpoint?.sectionBodies ?? {}) };
  const failures = { ...(job.checkpoint?.sectionFailures ?? {}) };
  let calls = Number(job.checkpoint?.sectionCalls ?? 0);
  let yielded = false;
  let rateLimited = false;
  let rateLimitError = null;
  let lastSavedCount = -1;
  const startedAt = new Date(job.startedAt ?? job.createdAt ?? Date.now()).getTime();

  for (const write of writes) {
    if (saved[keyFor(write)]) delete failures[keyFor(write)];
  }

  const todo = writes.filter((write) => !saved[keyFor(write)]);
  const doneBefore = writes.length - todo.length;
  await deps.setStage("writing", { done: doneBefore, total: writes.length });

  // The map stage persisted its call count through patchCheckpoint, which does
  // not mutate this in-memory job row. Read the authoritative number once, so
  // the AI-call budget covers map + reduce + sections instead of the snapshot
  // the job was loaded with (which is 0 on a fresh pass).
  const freshCheckpoint = await prisma.job
    .findUnique({ where: { id: job.id }, select: { checkpoint: true } })
    .catch(() => null);
  const callsBeforeSections = Number(
    freshCheckpoint?.checkpoint?.mapCalls ?? job.checkpoint?.mapCalls ?? 0,
  );

  const persist = async (progressIncrement = 0) => {
    await persistSectionState(job, { saved, failures, calls }, progressIncrement, deps);
  };

  await mapWithLimit(todo, Math.max(1, longDoc.sectionConcurrency), async (write) => {
    if (rateLimited || yielded) return;
    if (deps.deadline && Date.now() > deps.deadline) {
      yielded = true;
      return;
    }
    await (deps.assertJobActive ?? assertJobActive)(job);
    const key = keyFor(write);
    if (callsBeforeSections + calls >= longDoc.maxAiCallsPerJob) {
      failures[key] = { titles: write.titles, code: "AI_CALL_BUDGET" };
      await persist();
      return;
    }
    if (Date.now() - startedAt > longDoc.maxJobRuntimeMs) {
      throw new UserFacingError(
        "This file took too long to process. Tap Try again — finished sections are kept.",
      );
    }

    calls += 1;
    try {
      const body = await writeSectionBody({ write, kind, courseContext, sourceType, deps });
      saved[key] = body;
      delete failures[key];
      await persist(1);
      const done = writes.filter((item) => saved[keyFor(item)]).length;
      await deps.setStage("writing", { done, total: writes.length });
      if (onSaved && done !== lastSavedCount) {
        lastSavedCount = done;
        await onSaved(
          writes.map((item) => saved[keyFor(item)]).filter(Boolean),
        );
      }
    } catch (error) {
      if (error?.cancelled || error?.yield) throw error;
      if (error?.kind === "rate_limit" || RATE_LIMIT_RE.test(error?.message ?? "")) {
        rateLimited = true;
        rateLimitError = error;
        failures[key] = { titles: write.titles, code: "RATE_LIMITED" };
      } else {
        failures[key] = { titles: write.titles, code: "SECTION_FAILED" };
      }
      await persist();
    }
  });

  await persist();

  if (rateLimited) {
    throw new AiError(
      "rate_limit",
      "The AI service hit its rate limit or daily quota. Wait a few minutes and tap Try again — finished sections are kept.",
      { retryable: true, retryAfterMs: rateLimitError?.retryAfterMs ?? null },
    );
  }
  if (yielded) throw new JobYieldError("sections");

  const failedWrites = writes.filter((write) => failures[keyFor(write)]);
  if (writes.length && failedWrites.length / writes.length > longDoc.maxFailedSectionRatio) {
    throw new UserFacingError(
      "Too many parts of this file could not be written. Tap Try again, or upload it by chapter.",
    );
  }

  const savedWrites = writes.filter((write) => saved[keyFor(write)]);
  return {
    bodies: savedWrites.map((write) => saved[keyFor(write)]),
    failures,
    missingTitles: failedWrites.flatMap((write) => failures[keyFor(write)]?.titles ?? write.titles),
    sampled: writes.some((write) => write.sampled),
    written: savedWrites.reduce((sum, write) => sum + (write.sectionIds?.length ?? 1), 0),
    failed: failedWrites.reduce((sum, write) => sum + (write.sectionIds?.length ?? 1), 0),
  };
}

function keyTakeaways(overview) {
  const seen = new Set();
  const lines = [];
  for (const topic of overview?.topics ?? []) {
    for (const item of topic.emphasised ?? []) {
      const value = String(item ?? "").trim();
      const key = normaliseForCompare(value).toLowerCase();
      if (!value || seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${value}`);
      if (lines.length >= 6) break;
    }
    if (lines.length >= 6) break;
  }
  if (lines.length >= 2) return lines.join("\n");
  const fallback = dedupeTerms(overview)
    .slice(0, 4)
    .map((term) => `- **${term.term}** — ${term.definition}`);
  return fallback.length >= 2 ? fallback.join("\n") : "";
}

function overviewParagraph({ set, overview }) {
  const summary = String(set?.shortSummary ?? "").trim();
  if (summary) return summary;
  const points = [];
  for (const topic of overview?.topics ?? []) {
    for (const item of [...(topic.emphasised ?? []), ...(topic.points ?? [])]) {
      const value = String(item ?? "").trim();
      if (!value) continue;
      points.push(value);
      if (points.length >= 6) break;
    }
    if (points.length >= 6) break;
  }
  return clampChars(points.join(" "), 1200);
}

/** Assemble one note body: notices, overview, section pages, takeaways. */
export function assembleSectionedNote({
  notices = [],
  overviewText = "",
  bodies = [],
  takeaways = "",
  maxChars = notePipeline.bodyMaxChars,
}) {
  const noticeBlock = notices.filter(Boolean).join("\n\n");
  const overview = String(overviewText ?? "").trim();
  const takeawayBlock = String(takeaways ?? "").trim();
  const build = (list, dropped) =>
    [
      noticeBlock,
      overview ? `## Overview\n\n${overview}` : "",
      ...list,
      takeawayBlock ? `## Key Takeaways\n\n${takeawayBlock}` : "",
      dropped
        ? "> The rest of this note was shortened to fit. Upload the remaining chapters separately."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

  const list = bodies.filter(Boolean);
  let body = build(list, false);
  let dropped = 0;
  while (body.length > maxChars && list.length > 1) {
    list.pop();
    dropped += 1;
    body = build(list, true);
  }
  if (body.length > maxChars) body = body.slice(0, maxChars);
  return { body, dropped };
}

// ---------------------------------------------------------------------------
// Verify (3.8) — notices + coverage
// ---------------------------------------------------------------------------

function buildNotices({ truncated, pagesTotal, pagesUsed, lost, ocrUsed }) {
  const notices = [];
  if (truncated && pagesTotal > pagesUsed) {
    notices.push(
      `> Used the first ${pagesUsed} of ${pagesTotal} pages. Add the rest by chapter to cover everything.`,
    );
  }
  if (ocrUsed) {
    notices.push(
      `> ${ocrUsed} scanned page${ocrUsed === 1 ? "" : "s"} were read by OCR. Check numbers and diagrams against the original.`,
    );
  }
  if (lost.length) {
    notices.push(`> These parts could not be processed: ${lost.join(", ")}.`);
  }
  return notices;
}

function coverageOf({ sectionsCovered, sectionsTotal }) {
  return sectionsTotal > 0 ? sectionsCovered / sectionsTotal : 1;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

class JobCancelledError extends Error {
  constructor() {
    super("Job was cancelled");
    this.name = "JobCancelledError";
    this.cancelled = true;
  }
}

/** Quietly stop when the job row is gone, cancelled or done. */
async function assertJobActive(job) {
  const row = await withUserAliveCheck(job);
  if (!row || row.state === "cancelled") throw new JobCancelledError();
  if (row.state === "done") throw new JobCancelledError();
  return row;
}

async function withUserAliveCheck(job) {
  // Infra read: direct prisma (no note content, just the state field).
  try {
    return await prisma.job.findUnique({
      where: { id: job.id },
      select: { state: true },
    });
  } catch (error) {
    // A database/query failure is not a cancellation. Converting it to a
    // missing row leaves the claimed job running at its prior stage while the
    // runner clears its lease, so surface it to the runner's normal retry and
    // failure handling instead.
    const name = String(error?.name ?? "Error").replace(/\s+/g, " ").slice(0, 64);
    const code = error?.code ? ` code=${String(error.code).slice(0, 32)}` : "";
    const message = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 240);
    console.warn(`[long-doc-job-check] job=${job.id} stage=${job.stage ?? "-"} name=${name}${code} message=${message}`);
    throw error;
  }
}

/**
 * Whole long-file flow for one job. Returns { meta, parts } where meta feeds
 * job.payload diagnostics exactly like the short pipeline's meta.
 */
export async function runLongDocJob({ job, note, kind, clerkId, deps, source: providedSource = null }) {
  const startedMs = Date.now();

  await deps.assertAlive();
  // The caller already loaded the chunk rows; re-reading them doubled the
  // first query of every long pass.
  const source = providedSource ?? (await loadChunkedSource(clerkId, note));
  if (!source) throw new Error("long-doc invoked without extracted chunks");

  const courseContext = [note.course?.name, note.course?.code ? `course code ${note.course.code}` : ""]
    .filter(Boolean)
    .join(", ");
  const sourceType = "file";

  // Progress unit: chunk groups of this file. Sources with fewer than four
  // stored rows have no outline; one synthetic section still lets map/reduce
  // see the whole blob and produce a real summary and body.
  const lastPage = source.rows[source.rows.length - 1]?.endPage ?? source.rows.length;
  let sections = buildSections({
    rows: source.rows,
    structureHints: source.structureHints,
    pageCount: lastPage,
  });
  if (!sections.length) {
    sections = [{ id: "s1", title: "", startPage: 1, endPage: Math.max(1, lastPage) }];
  }
  const groups = groupRowsIntoChunks({ rows: source.rows, sections });
  if (!groups.length) throw new UserFacingError("Couldn't read text from this file. Try a clearer PDF or re-upload.");

  const truncated = (note.assets ?? [])
    .filter((asset) => asset.kind === "document")
    .some((asset) => asset.truncated);
  const pagesTotal = Math.max(
    ...(note.assets ?? []).filter((a) => a.kind === "document").map((a) => a.pagesTotal ?? 0),
    source.rows[source.rows.length - 1]?.endPage ?? 0,
    1,
  );
  const pagesUsed = source.rows[source.rows.length - 1]?.endPage ?? source.rows.length;
  const ocrUsed = (note.assets ?? []).reduce(
    (sum, asset) => sum + (asset.kind === "document" ? asset.ocrPages ?? 0 : 0),
    0,
  );

  // ---- Map -----------------------------------------------------------------
  const map = await mapDigests({ job, groups, courseContext, sourceType, deps });
  await assertJobActive(job);

  // ---- Reduce ---------------------------------------------------------------
  const reduce = await reduceDigests({ job, digests: map.digests, groups, sections, sourceType, courseContext, deps });
  await assertJobActive(job);

  const summaryList = reduce.summaryList.filter(Boolean);
  const overviewMaterial = summaryToMergeMaterial(
    reduce.summaryList.filter((item) => item?.summary).map((item) => item.summary),
  );

  const notices = buildNotices({
    truncated,
    pagesTotal,
    pagesUsed,
    lost: map.lost,
    ocrUsed,
  });

  // ---- Study pack (checkpointed; persisted before the section writes) ------
  // Summary/cards/quiz survive even if a later section write yields or fails.
  await deps.setStage("summarising");
  const spec = buildStudyPackSchema(scaledSpec(sections.length || 3));
  const studyMaterial = clampChars(overviewMaterial || rawTextOfAll(source.rows), WRITE_MAX_CHARS);
  const studyKey = `studySet:${sha1(studyMaterial)}:${PROMPT_VERSION}:${bulkModel()}:${sections.length}`;
  let set = null;
  if (job.checkpoint?.studySet?.key === studyKey) {
    const checked = validateStudyPack(job.checkpoint.studySet.value);
    if (checked.success) set = { ...checked.data, summaryMarkdown: summaryToMarkdown(checked.data) };
  }
  if (!set) {
    set = await generateStudySetForMaterial({ material: studyMaterial, courseContext, spec, deps });
    await patchCheckpoint(job.id, { studySet: { key: studyKey, value: set } }, {}, deps);
  }
  await persistStudySet(clerkId, note, set, true);
  await assertJobActive(job);

  // ---- Section bodies -------------------------------------------------------
  const overviewText = overviewParagraph({ set, overview: reduce.overview });
  const takeaways = keyTakeaways(reduce.overview);
  const defaultTitle = note.title || (kind === "course_reference" ? "Reference sheet" : "Study notes");
  let writes = planSectionWrites({
    sections,
    summaryList: reduce.summaryList,
    groups,
    kind,
    pagesUsed,
    defaultTitle,
  });
  if (!writes.length) {
    // Outline collapsed to nothing: one full write, still one note.
    const material = clampChars(overviewMaterial || rawTextOfAll(source.rows), WRITE_MAX_CHARS);
    const titles = uniqueHeadings([defaultTitle]);
    const maxWords = sectionBudget(kind, pagesUsed, 1);
    writes = [
      {
        index: 0,
        sectionId: "s1",
        sectionIds: ["s1"],
        titles,
        pages: "",
        material,
        rawText: rawTextOfAll(source.rows) || material,
        sampled: false,
        sectionHashes: [],
        maxWords,
        hash: sha1(`${titles[0]}|${sha1(material)}|${maxWords}`),
      },
    ];
  }

  const partialWriter = longDoc.persistPartialBody
    ? async (bodies) => {
        const partial = assembleSectionedNote({
          notices,
          overviewText,
          bodies,
          takeaways: "",
          maxChars: notePipeline.bodyMaxChars,
        });
        await withUser(clerkId, (tx) =>
          tx.note.update({ where: { id: note.id }, data: { body: partial.body } }),
        ).catch((error) => {
          console.warn(`partial note write failed for note ${note.id}: ${error?.message ?? error}`);
        });
      }
    : null;

  const sectionResult = await writeSectionBodies({
    job,
    writes,
    kind,
    courseContext,
    sourceType,
    deps,
    onSaved: partialWriter,
  });
  await assertJobActive(job);

  const sectionNotices = notices.slice();
  if (reduce.degraded?.length) {
    // Honest, not silent: the sections are all present (nothing was dropped),
    // but they were combined locally instead of by the model.
    sectionNotices.push(
      `> ${reduce.degraded.length} part(s) were combined locally because the AI could not merge them. Everything from the file is here, but those parts read as lists rather than prose.`,
    );
  }
  if (sectionResult.sampled) {
    sectionNotices.push(
      "> Some sections use a sampled portion of the source to fit the AI limits. Check against the file.",
    );
  }
  if (sectionResult.missingTitles.length) {
    sectionNotices.push(
      `> These parts could not be written: ${sectionResult.missingTitles.join(", ")}.`,
    );
  }
  const assembled = assembleSectionedNote({
    notices: sectionNotices,
    overviewText,
    bodies: sectionResult.bodies,
    takeaways,
    maxChars: notePipeline.bodyMaxChars,
  });

  // Old split rows from THIS job are duplicates of the note just rebuilt.
  const legacyIds = longDoc.cleanupLegacyParts ? await findLegacyParts(clerkId, job) : [];
  const storageKeys = await withUser(clerkId, async (tx) => {
    await tx.note.update({
      where: { id: note.id },
      data: {
        body: assembled.body,
        summary: set.summaryMarkdown,
        transcript: rawTextOfAll(source.rows).slice(0, MAX_TEXT_CHARS),
      },
    });
    if (!legacyIds.length) return [];
    await tx.noteTombstone.createMany({
      data: legacyIds.map((id) => ({ id, userId: job.userId })),
      skipDuplicates: true,
    });
    return purgeNoteRows(tx, { userId: job.userId, noteIds: legacyIds });
  });
  if (storageKeys.length) await flushStorageDeletes(storageKeys, job.userId);

  const coverage = coverageOf({
    sectionsCovered: sectionResult.written,
    sectionsTotal: Math.max(1, sections.length),
  });

  return {
    meta: longDocMeta({
      mode: "sectioned",
      pagesTotal,
      pagesUsed,
      sections: Math.max(1, sections.length),
      sectionsWritten: sectionResult.written,
      sectionsFailed: sectionResult.failed,
      writtenNotes: [note.id],
      lost: map.lost,
      coverage,
      notices: sectionNotices,
      fidelityNotice: sectionNotices.some((notice) => notice.includes("numbers")),
      reduceDegraded: reduce.degraded?.length ?? 0,
      startedMs,
      groupId: null,
      truncated,
    }),
    parts: [note.id],
    groupId: null,
  };
}

async function findLegacyParts(clerkId, job) {
  const rows = await withUser(clerkId, (tx) =>
    tx.note.findMany({
      where: {
        userId: job.userId,
        OR: [{ id: `ovw_${job.id}` }, { id: { startsWith: `part_${job.id}_` } }],
      },
      select: { id: true },
    }),
  );
  return rows.map((row) => row.id);
}

function summaryToMergeMaterial(summaries) {
  return summaries.map((summary) => digestToText(summary)).join("\n\n");
}

function rawTextOfAll(rows) {
  return clampChars(
    rows.map((row) => row.text ?? "").join("\n\n"),
    longDoc.maxSourceChars,
  );
}

function clampChars(value, max) {
  return String(value ?? "").slice(0, max);
}

function longDocMeta({ mode, pagesTotal, pagesUsed, sections, sectionsWritten, sectionsFailed, writtenNotes, lost, coverage, notices, fidelityNotice, reduceDegraded = 0, startedMs, groupId, truncated }) {
  return {
    promptVersion: PROMPT_VERSION,
    sourceType: "file",
    stageReached: "ready",
    truncated: Boolean(truncated),
    pagesUsed,
    pageCount: pagesTotal,
    minutes: 0,
    digests: sections,
    writeRetries: 0,
    unsupportedNumbers: [],
    unsupportedFormulas: [],
    words: 0,
    modelCalls: 0,
    checkPassed: coverage >= longDoc.minCoverage,
    fidelityFailed: Boolean(fidelityNotice),
    structureProblems: [],
    chain: "long-doc",
    mode,
    partsCount: 1,
    sectionsCount: sections,
    sectionsWritten: sectionsWritten ?? 0,
    sectionsFailed: sectionsFailed ?? 0,
    noteIds: writtenNotes ?? [],
    buildRevision: LONG_DOC_REVISION,
    coverage: Number(coverage.toFixed(3)),
    lostRanges: lost.slice(0, 10),
    notices: (notices ?? []).map((notice) => notice.replace(/^> /, "")).slice(0, 5),
    reduceDegraded: Number(reduceDegraded) || 0,
    groupId,
    durationMs: Date.now() - startedMs,
  };
}

function dedupeTerms(overview) {
  const terms = new Map();
  for (const topic of overview?.topics ?? []) {
    for (const term of topic.terms ?? []) {
      const key = normaliseForCompare(term.term).toLowerCase();
      if (!key) continue;
      const existing = terms.get(key);
      if (!existing || term.definition.length > existing.definition.length) {
        terms.set(key, { term: term.term, definition: term.definition });
      }
    }
  }
  return [...terms.values()].slice(0, 30);
}

/**
 * Study-set persistence for any note (short path forwards here too):
 * cards match by normalised front and keep their SM-2 fields; new cards
 * insert; vanished cards soft-retire. The quiz row keeps its id so attempt
 * history survives; its questions replace.
 */
export async function persistStudySet(clerkId, noteRow, set, bodyPreserve = false) {
  await withUser(clerkId, async (tx) => {
    await tx.note.update({
      where: { id: noteRow.id },
      data: { summary: set.summaryMarkdown, ...(bodyPreserve ? {} : { body: set.summaryMarkdown }) },
    });
    const existingCards = await tx.flashcard.findMany({
      where: { noteId: noteRow.id, retiredAt: null },
      select: { id: true, front: true, ease: true, intervalDays: true, reps: true, dueAt: true },
    });
    const byKey = new Map(existingCards.map((card) => [cardFrontKey(card.front), card]));
    const matched = [];
    const toInsert = [];
    for (const card of set.flashcards) {
      const match = byKey.get(cardFrontKey(card.front));
      if (match) matched.push({ old: match, incoming: card });
      else
        toInsert.push({
          userId: noteRow.userId,
          noteId: noteRow.id,
          courseId: noteRow.courseId,
          front: String(card.front).slice(0, 2000),
          back: String(card.back).slice(0, 4000),
        });
    }
    for (const item of matched.slice(0, 400)) {
      await tx.flashcard.update({
        where: { id: item.old.id },
        data: { back: String(item.incoming.back).slice(0, 4000), retiredAt: null },
      });
    }
    const incomingKeys = new Set(
      set.flashcards.map((card) => cardFrontKey(card.front)),
    );
    const retireIds = existingCards
      .filter((card) => !incomingKeys.has(cardFrontKey(card.front)))
      .map((card) => card.id);
    if (retireIds.length) {
      await tx.flashcard.updateMany({
        where: { id: { in: retireIds.slice(0, 400) } },
        data: { retiredAt: new Date() },
      });
    }
    if (toInsert.length) {
      await tx.flashcard.createMany({ data: toInsert.slice(0, 200) });
    }

    let quizId = null;
    const oldQuizzes = await tx.quiz.findMany({ where: { noteId: noteRow.id }, select: { id: true } });
    if (oldQuizzes.length) {
      quizId = oldQuizzes[0].id;
      await tx.quizQuestion.deleteMany({ where: { quizId: { in: oldQuizzes.map((quiz) => quiz.id) } } });
      if (oldQuizzes.length > 1) {
        await tx.quiz.deleteMany({ where: { id: { in: oldQuizzes.slice(1).map((quiz) => quiz.id) } } });
      }
      await tx.quiz.update({ where: { id: quizId }, data: { title: `${noteRow.title || "Untitled note"} quiz` } });
    } else {
      const quiz = await tx.quiz.create({
        data: {
          userId: noteRow.userId,
          courseId: noteRow.courseId,
          noteId: noteRow.id,
          title: `${noteRow.title || "Untitled note"} quiz`,
        },
      });
      quizId = quiz.id;
    }
    await tx.quizQuestion.createMany({
      data: (set.quiz ?? []).map((question, index) => ({
        quizId,
        ordinal: index + 1,
        type: question.type,
        prompt: String(question.prompt).slice(0, 4000),
        options: question.options ? question.options.map(String) : null,
        answer: String(question.answer).slice(0, 2000),
        explanation: String(question.explanation ?? "").slice(0, 4000),
      })),
    });
  });
}

/** Identical normalisation to the progress-preserving matcher. */
export function cardFrontKey(front) {
  return normaliseForCompare(String(front ?? ""))
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .toLowerCase()
    .trim();
}
