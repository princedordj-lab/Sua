/**
 * Long-file pipeline: Structure -> Chunk -> Map (checkpointed) -> Reduce ->
 * Generate (split | single) -> Verify -> Persist.
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
import { bulkModel, strongModel, chatCompletion } from "./ai.js";
import {
  digestChunk,
  digestToText,
  mapWithLimit,
  validateDigest,
  parseJsonObject,
  normaliseHeadings,
} from "./note-pipeline.js";
import {
  PROMPT_VERSION,
  reducePrompt,
  overviewPrompt,
  lectureNotePrompt,
  referencePrompt,
} from "./prompts.js";
import { longDoc, notePipeline, UserFacingError } from "../config/ai-pipeline.js";
import { validateStudyPack } from "../config/study-pack-schema.js";
import { checkSourceFidelity, normaliseForCompare } from "./numbers.js";
import { MAX_TEXT_CHARS } from "./extract.js";

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

/** Stable over the file's content: the rerun-guard hash of a chunked source. */
export function chunkedSourceHash(source) {
  return sha1(source.rows.map((row) => row.hash ?? row.text ?? "").join("|"));
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
    await prisma.job
      .update({
        where: { id: job.id },
        data: {
          checkpoint: {
            digests: saved,
            digestFailures: failures,
            mapCalls: (job.checkpoint?.mapCalls ?? 0) + calls,
          },
        },
      })
      .catch(() => {});
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
    const checkpoint = await prisma.job.findUnique({ where: { id: job.id }, select: { checkpoint: true } }).catch(() => null);
    const mapCalls = checkpoint?.checkpoint?.mapCalls ?? (job.checkpoint?.mapCalls ?? 0) + calls;
    if (Date.now() - new Date(job.startedAt ?? job.createdAt).getTime() > longDoc.maxJobRuntimeMs) {
      throw new UserFacingError(
        "This file took too long to process. Tap Try again — finished pages are kept.",
      );
    }
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
      await prisma.job
        .update({
          where: { id: job.id },
          data: {
            checkpoint: { digests: saved, digestFailures: failures, mapCalls },
            progressDone: { increment: 1 },
          },
        })
        .catch(() => {});
      await emitCheckpoint();
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      if (RATE_LIMIT_RE.test(error?.message ?? "")) {
        rateLimited = true;
        failures[group.hash] = { label: group.labelRange, code: "RATE_LIMITED" };
      } else {
        failures[group.hash] = { label: group.labelRange, code: "DIGEST_FAILED" };
      }
      await persistMapState();
    }
  });

  await persistMapState();

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
      if (Date.now() - new Date(job.startedAt ?? job.createdAt).getTime() > longDoc.maxJobRuntimeMs) break;
      calls += 1;
      try {
        const digest = await digestChunk(
          { index: group.index, labels: group.labels, text: group.text },
          { courseContext, sourceType, chunkCount: groups.length },
          deps,
        );
        saved[digestCacheKey(group, model)] = digest;
        delete failures[group.hash];
        await prisma.job
          .update({
            where: { id: job.id },
            data: {
              checkpoint: { digests: saved, digestFailures: failures, mapCalls },
              progressDone: { increment: 1 },
            },
          })
          .catch(() => {});
        await emitCheckpoint();
      } catch (error) {
        if (RATE_LIMIT_RE.test(error?.message ?? "")) {
          rateLimited = true;
          failures[group.hash] = { label: group.labelRange, code: "RATE_LIMITED" };
          break;
        }
        await persistMapState();
      }
    }
    await persistMapState();
  }

  if (rateLimited) {
    throw new UserFacingError(
      "The AI service hit its rate limit or daily quota. Wait a few minutes and tap Try again — finished pages are kept.",
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
  const waves = [];
  let wave = [];
  let chars = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length + 1;
    const full = wave.length && (chars + size > budget || wave.length >= longDoc.reduceGroupSize);
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

/**
 * Merge several digests into one summary of the same shape. Retries once at
 * temperature 0. Inputs are wave-sized by partitionWaves; a lone oversized
 * digest is compacted (slimDigest), never truncated.
 */
async function mergeDigests({ digests, prompt, step, deps }) {
  const budget = Math.floor(longDoc.reduceMaxChars * 0.85);
  let payload = JSON.stringify(digests);
  if (payload.length > budget) {
    const share = Math.floor(budget / Math.max(1, digests.length));
    payload = JSON.stringify(digests.map((digest) => slimDigest(digest, share)));
  }
  const attempt = async (stricter) => {
    const result = await chatCompletion({
      system:
        "You merge structured study material for a university student revising for exams. " +
        "Output ONLY valid JSON matching the requested shape — no prose, no code fences." +
        (stricter ? " Schema exactly as instructed. No extra keys." : ""),
      user: `${prompt}\n\n=== DIGESTS ===\n${payload}`,
      model: mergeModel(),
      json: true,
      temperature: stricter ? 0 : 0.2,
      maxTokens: notePipeline.studySetMaxTokens,
    });
    await deps.record(stricter ? `${step}_retry` : step, result);
    const parsed = parseJsonObject(result.text);
    const problem = parsed ? validateDigest(parsed) : "unparseable JSON";
    return { parsed, problem };
  };
  let outcome = await attempt(false);
  if (outcome.problem) outcome = await attempt(true);
  if (outcome.problem) throw new Error(`Merge failed validation (${outcome.problem})`);
  return {
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
          meaning: String(symbol?.meaning ?? ""),
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
}

/**
 * Group digests by outline section (~reduceGroupSize per wave, cascading
 * waves when a section has more), then build the document-level overview.
 * Every checkpoint is written to job.checkpoint.reduce keyed by section +
 * wave + prompt version + model.
 */
export async function reduceDigests({ job, digests, groups, sections, sourceType, courseContext, deps }) {
  const reduceKey = (id, waveIndex, model) => `${id}:${waveIndex}:${PROMPT_VERSION}:${model}`;
  const saved = { ...(job.checkpoint?.reduce ?? {}) };

  const summariesFor = {};

  for (const section of sections) {
    const entries = groups
      .filter((group) => group.sectionId === section.id)
      .map((group) => digests[digestCacheKey(group, bulkModel())])
      .filter(Boolean);
    if (!entries.length) continue;

    const waves = partitionWaves(entries, longDoc.reduceMaxChars);
    let merged = null;
    for (const [waveIndex, wave] of waves.entries()) {
      const cacheKey = reduceKey(section.id, waveIndex, mergeModel());
      const cached = saved[cacheKey];
      const waveResult = cached ?? (await withStage(deps, "merging", () =>
        mergeDigests({
          digests: wave,
          prompt: reducePrompt({ course: courseContext, sourceType, groupIndex: waveIndex, groupCount: waves.length }),
          step: waveIndex === 0 ? "reduce" : "reduce_wave",
          deps,
        })));
      if (!cached) {
        saved[cacheKey] = waveResult;
        await prisma.job
          .update({
            where: { id: job.id },
            data: {
              checkpoint: {
                digests: job.checkpoint?.digests ?? {},
                digestFailures: job.checkpoint?.digestFailures ?? {},
                reduce: saved,
              },
            },
          })
          .catch(() => {});
      }
      merged = merged ? mergeSummaries(merged, waveResult) : waveResult;
    }
    summariesFor[section.id] = { summary: merged, section };
  }

  const summaryList = Object.values(summariesFor);
  const overviewKey = `overview:${PROMPT_VERSION}:${mergeModel()}`;
  let overview = saved[`overview:${PROMPT_VERSION}:${mergeModel()}`];
  if (!overview && summaryList.length) {
    // Capacity-based waves over the section summaries; oversized summaries
    // cascade instead of overflowing the merge prompt.
    const waves = partitionWaves(
      summaryList.map((item) => item.summary),
      longDoc.reduceMaxChars,
    );
    let merged = null;
    for (const [waveIndex, wave] of waves.entries()) {
      const cacheKey = reduceKey("overview", waveIndex, mergeModel());
      const waveResult = saved[cacheKey] ?? (await withStage(deps, "merging", () =>
        mergeDigests({
          digests: wave,
          prompt: overviewPrompt({ course: courseContext, sourceType, sectionCount: summaryList.length }),
          step: "overview",
          deps,
        })));
      if (!saved[cacheKey]) {
        saved[cacheKey] = waveResult;
        await prisma.job
          .update({
            where: { id: job.id },
            data: {
              checkpoint: {
                digests: job.checkpoint?.digests ?? {},
                digestFailures: job.checkpoint?.digestFailures ?? {},
                reduce: saved,
              },
            },
          })
          .catch(() => {});
      }
      merged = merged ? mergeSummaries(merged, waveResult) : waveResult;
    }
    overview = merged;
    saved[overviewKey] = overview;
  }

  return { summariesFor, summaryList, overview };
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
    const result = await chatCompletion({
      system: stricter
        ? "You are Sua. Output ONLY valid JSON matching the requested study pack schema exactly — no prose, no code fences."
        : "You are Sua, an exam-focused study assistant for African university students. Use only the material provided. Write clearly in simple English. Output only valid JSON.",
      user: `${prompt}\n\n=== LECTURE MATERIAL ===\n${material}`,
      model: bulkModel(),
      json: true,
      maxTokens: notePipeline.studySetMaxTokens,
      temperature: stricter ? 0 : 0.2,
    });
    await deps.record(stricter ? "generate_study_set_retry" : "generate_study_set", result);
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
// Body writers for lecture_note / course_reference per part
// ---------------------------------------------------------------------------

const WRITE_MAX_CHARS = 40_000;

function splitMaterial(material) {
  if (material.length <= WRITE_MAX_CHARS) return [material];
  const paragraphs = material.split(/\n{2,}/);
  const parts = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > WRITE_MAX_CHARS) {
      parts.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) parts.push(current);
  return parts;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING_LINE = /^(#{1,6})(\s+.*)$/;

async function writeBody({ system, material, deps, step }) {
  const parts = splitMaterial(material);
  const written = [];
  for (const [index, part] of parts.entries()) {
    const tail = written.length ? written[written.length - 1].slice(-900).trim() : "";
    const continuation =
      parts.length > 1
        ? `This is part ${index + 1}/${parts.length} of one long material. Continue the note seamlessly: keep one coherent heading structure and do not repeat a heading.` +
          (tail ? `\nThe previous part ended with:\n"""\n${tail}\n"""\nContinue from there.` : "")
        : "";
    const result = await chatCompletion({
      system,
      user: `${continuation}\n\n=== MATERIAL ===\n${part}`,
      model: strongModel(),
      temperature: 0.2,
      maxTokens: notePipeline.writeMaxTokens,
    });
    await deps.record(index === 0 ? step : `${step}_part`, result);
    const body = String(result.text ?? "").trim();
    if (body) written.push(body);
  }
  return normaliseHeadings(written.join("\n\n"));
}

function structureProblems(body, kind) {
  const problems = [];
  if (!/^##\s/m.test(body)) problems.push("no ## sections");
  if (/^\s*\|.*\|\s*$/m.test(body)) problems.push("markdown tables");
  if (/\$\$|\\frac|\\times|\\cdot/.test(body)) problems.push("LaTeX");
  const words = body.split(/\s+/).filter(Boolean).length;
  if (kind === "course_reference" && words > Math.round(notePipeline.referenceMaxWords * 1.15)) {
    problems.push(`over ${notePipeline.referenceMaxWords} words`);
  }
  return { problems, words };
}

async function writePartBody({ kind, material, rawText, courseContext, sourceType, deps }) {
  const system =
    kind === "course_reference"
      ? referencePrompt({ course: courseContext, sourceType, maxWords: notePipeline.referenceMaxWords })
      : lectureNotePrompt({ course: courseContext, sourceType });
  const context =
    kind === "course_reference"
      ? "Write the reference sheet for this part of the material."
      : "Write the complete, well-structured study note for this part of the material.";

  let body = await writeBody({ system, material: `${context}\n\n${material}`, deps, step: kind === "course_reference" ? "reference_write" : "note_write" });
  let fidelity = checkSourceFidelity({ source: rawText, output: body, allow: courseContext });
  let structure = structureProblems(body, kind);
  if (fidelity.failed || structure.problems.length) {
    const suffix = [
      fidelity.failed
        ? `Your previous answer contained numbers/formulas not in the source: ${fidelity.unsupportedFormulas.concat(fidelity.unsupportedNumbers).slice(0, 12).join(", ")}. Rewrite using only values that appear in the source.`
        : "",
      structure.problems.length ? `Your previous answer had these problems: ${structure.problems.join(", ")}. Fix them.` : "",
    ]
      .filter(Boolean)
      .join("\n");
    body = await writeBody({ system, material: `${suffix}\n\n${context}\n\n${material}`, deps, step: "write_retry" });
    fidelity = checkSourceFidelity({ source: rawText, output: body, allow: courseContext });
    structure = structureProblems(body, kind);
  }
  return { body, fidelity, structure };
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
      select: { state: true, claimedAt: true },
    });
  } catch {
    return null;
  }
}

/**
 * Whole long-file flow for one job. Returns { meta, parts } where meta feeds
 * job.payload diagnostics exactly like the short pipeline's meta.
 */
export async function runLongDocJob({ job, note, kind, clerkId, deps }) {
  const startedMs = Date.now();

  await deps.assertAlive();
  const source = await loadChunkedSource(clerkId, note);
  if (!source) throw new Error("long-doc invoked without extracted chunks");

  const courseContext = [note.course?.name, note.course?.code ? `course code ${note.course.code}` : ""]
    .filter(Boolean)
    .join(", ");
  const sourceType = "file";
  const documentSourceAssetId = (note.assets ?? []).find((asset) => asset.kind === "document")?.id ?? null;

  // Progress unit: chunk groups of this file.
  const sections = buildSections({
    rows: source.rows,
    structureHints: source.structureHints,
    pageCount: source.rows[source.rows.length - 1]?.endPage ?? source.rows.length,
  });
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
  const coveredSections = summaryList.length;

  const notices = buildNotices({
    truncated,
    pagesTotal,
    pagesUsed,
    lost: map.lost,
    ocrUsed,
  });
  const coverage = coverageOf({
    sectionsCovered: coveredSections,
    sectionsTotal: sections.length,
  });

  // ---- Mode -----------------------------------------------------------------
  // A source fewer pages than the split threshold keeps today's single-note
  // behaviour (the same code path, one generation, no parts). LONG_DOC_MODE
  // forces single (layered) or split for long files.
  const longEnough = pagesTotal > longDoc.splitPages;
  const mode = !longEnough
    ? "short"
    : longDoc.mode === "single"
      ? "single"
      : longDoc.mode === "short"
        ? "short"
        : "split";

  const overviewMaterial = summaryToMergeMaterial(reduce.summaryList.map((s) => s.summary));

  let parts = mode === "split" ? splitParts({ sections, summaryList: reduce.summaryList, rows: source.rows }) : [];
  let effectiveMode = mode;
  if (mode === "split" && !parts.length) {
    // A long file whose outline collapsed to nothing still deserves full
    // treatment: fall back to the layered single note.
    effectiveMode = "single";
  }

  if (effectiveMode === "split") {
    const groupId = `grp_${job.id}`;
    const results = [];
    // Overview note (partIndex 0) first, so the student sees the whole picture
    // (and its Links) while parts are still being written.
    const overviewPersisted = await persistOverviewNote({
      job, note, kind, clerkId, groupId,
      overview: reduce.overview ?? summaryToMergeMaterial(reduce.summaryList.map((s) => s.summary)),
      summaryList: reduce.summaryList,
      notices, sourceAssetId: documentSourceAssetId,
    });
    results.push(overviewPersisted);

    for (const [index, part] of parts.entries()) {
      await assertJobActive(job);
      await deps.setStage("writing", { done: index + 1, total: parts.length + 1 });
      const rawText = clampChars(part.rawRows.map((row) => row.text ?? "").join("\n\n"), WRITE_MAX_CHARS);
      const perPartNotices = notices.slice();
      const partContext =
        `This study pack covers part ${index + 1} of ${parts.length} of a long file: "${part.title}" ` +
        `(${part.startLabel ? part.startLabel : `pages ${part.startPage}-${part.endPage}`}). Cite pages like (p. 12) for key facts.`;

      let body = "";
      let fidelity = null;
      let set = null;
      if (kind === "study_set") {
        set = await generateStudySetForMaterial({
          material: `${partContext}\n\n${part.material}`,
          courseContext,
          spec: null,
          deps,
        });
        body = set.summaryMarkdown;
      } else {
        const written = await writePartBody({
          kind, material: `${partContext}\n\n${part.material}`, rawText, courseContext, sourceType, deps,
        });
        body = written.body;
        fidelity = { failed: written.fidelity.failed, unsupportedNumbers: written.fidelity.unsupportedNumbers };
        if (fidelity.failed) {
          perPartNotices.unshift(
            "> Some numbers could not be matched to your original. Check against the file.",
          );
        }
        if (kind === "course_reference") {
          set = await generateStudySetForMaterial({
            material: `${partContext}\n\n${part.material}`,
            courseContext,
            spec: null,
            deps,
          }).catch(() => null);
        }
      }
      const noticeBlock = perPartNotices.length ? `${perPartNotices.join("\n\n")}\n\n` : "";
      const persisted = await persistPartNote({
        job, note, kind, clerkId, groupId, partIndex: index + 1,
        title: `${note.title || "Study pack"} — Part ${index + 1}: ${part.title}`,
        body: normaliseHeadings(truncateWords(noticeBlock + body, longDoc.noteBodyMaxWords)),
        set,
        transcript: rawText.slice(0, MAX_TEXT_CHARS),
        sourceAssetId: documentSourceAssetId,
      });
      results.push(persisted);
    }
    return {
      meta: longDocMeta({ mode, pagesTotal, pagesUsed, sections: sections.length, parts: parts.length, lost: map.lost, coverage, notices, fidelityNotice: notices.some((notice) => notice.includes("numbers")), startedMs, groupId, truncated }),
      parts: results,
      groupId,
    };
  }

  // ---- short + single modes: the job's own note ---------------------------
  await deps.setStage("writing");
  const spec = buildStudyPackSchema(scaledSpec(sections.length || 3));
  const material = clampChars(
    (mode === "single" ? overviewMaterial : overviewMaterial + "\n\n" + rawTextOfAll(source.rows)),
    WRITE_MAX_CHARS,
  );
  const set = await generateStudySetForMaterial({ material, courseContext, spec, deps });
  let body = "";
  if (kind !== "study_set") {
    const written = await writePartBody({
      kind,
      material,
      rawText: rawTextOfAll(source.rows),
      courseContext,
      sourceType,
      deps,
    });
    body = written.body;
    if (written.fidelity.failed) {
      notices.unshift("> Some numbers could not be matched to your original. Check against the file.");
    }
    if (kind === "course_reference" && pagesTotal > 1) {
      body = `> Condensed from ${pagesUsed} page${pagesUsed === 1 ? "" : "s"}.\n\n${body}`;
    }
  } else if (mode === "single") {
    // Layered body: overview first, then one ## section per chapter group,
    // then key terms + exam questions. study_set keeps note.body untouched;
    // this becomes the summary's extra material via transcript context only.
    const layered = [
      "## Overview",
      String(set.shortSummary ?? ""),
      "",
      ...reduce.summaryList.map((item) => `## ${item.section?.title ?? "Section"}\n\n${digestToText(item.summary)}`),
    ].join("\n\n");
    body = normaliseHeadings(truncateWords(layered, longDoc.noteBodyMaxWords));
  }
  const noticeBlock = notices.length ? `${notices.join("\n\n")}\n\n` : "";
  const bodyValue = kind === "study_set"
    ? note.body ?? ""
    : (mode === "single" ? noticeBlock + body : truncateWords(noticeBlock + body, longDoc.noteBodyMaxWords));
  await withUser(clerkId, async (tx) => {
    await tx.note.update({
      where: { id: note.id },
      data: {
        summary: set.summaryMarkdown,
        body: bodyValue.slice(0, notePipeline.bodyMaxChars),
        transcript: rawTextOfAll(source.rows).slice(0, MAX_TEXT_CHARS),
      },
    });
  });
  await persistStudySet(clerkId, note, set, true);

  return {
    meta: longDocMeta({ mode, pagesTotal, pagesUsed, sections: sections.length, parts: 1, lost: map.lost, coverage, notices, fidelityNotice: notices.some((notice) => notice.includes("numbers")), startedMs, groupId: null, truncated }),
    parts: [note.id],
    groupId: null,
  };
}

// ---------------------------------------------------------------------------
// Split parts (3.7 split mode)
// ---------------------------------------------------------------------------

/** Group outline sections into parts of ~splitPages (8-20 pages). */
function splitParts({ sections, summaryList, rows }) {
  const bySectionId = new Map(sections.map((section) => [section.id, section]));
  const parts = [];
  let current = { sectionIds: [], pages: 0 };
  const flush = () => {
    if (!current.sectionIds.length) return;
    const partSections = current.sectionIds.map((id) => bySectionId.get(id)).filter(Boolean);
    if (!partSections.length) return;
    const partSummaries = partSections
      .map((section) => summaryList.find((item) => item.summary && item.section?.id === section.id))
      .filter(Boolean);
    const startPage = Math.min(...partSections.map((section) => section.startPage ?? 1));
    const endPage = Math.max(...partSections.map((section) => section.endPage ?? 1));
    // Raw rows for this part: pages within the part's span, doubled back over
    // sections that carry no page numbers (row-based spans).
    const sectionIds = new Set(partSections.map((section) => section.id));
    const partRows = rows.filter(
      (row) =>
        (row.startPage ?? 1) >= startPage && (row.endPage ?? 1) <= endPage,
    );
    const fillerRows = partRows.length ? partRows : rows.slice(...rowSpanOf(partSections, rows));
    const title = partSections[0]?.title ?? `Part ${parts.length + 1}`;
    parts.push({
      title,
      pages: current.pages,
      startPage,
      endPage,
      startLabel: partSections[0]?.rows?.[0]?.label ?? null,
      sectionIds: [...sectionIds],
      // Study pack + body material: merged section summaries (the reduced
      // view of this part), which cite pages back into the raw text.
      material: clampChars(
        partSummaries.map((item) => digestToText(item.summary)).join("\n\n"),
        WRITE_MAX_CHARS,
      ),
      rawRows: fillerRows,
    });
    current = { sectionIds: [], pages: 0 };
  };
  for (const section of sections) {
    const sectionPages = Math.max(1, (section.endPage ?? 1) - (section.startPage ?? 1) + 1);
    if (current.pages + sectionPages > 2 * longDoc.splitPages && current.sectionIds.length) flush();
    if (current.pages >= longDoc.splitPages && current.sectionIds.length) flush();
    current.sectionIds.push(section.id);
    current.pages += sectionPages;
  }
  flush();
  return parts.map((part, index) => ({
    ...part,
    rawRows: part.rawRows.length ? part.rawRows : rows,
    ordinal: index + 1,
  }));
}

/** Row span over an outline-less part (DOCX where "pages" are spans). */
function rowSpanOf(partSections, rows) {
  const indexes = partSections
    .filter((section) => Number.isFinite(section.rowStart))
    .flatMap((section) => [section.rowStart, section.rowEnd]);
  if (indexes.length >= 2) {
    return [Math.min(...indexes), Math.max(...indexes)];
  }
  return [0, rows.length];
}

function summaryToMergeMaterial(summaries) {
  return summaries.map((summary) => digestToText(summary)).join("\n\n");
}

function rawTextOfAll(source) {
  return clampChars(
    source.rows.map((row) => row.text ?? "").join("\n\n"),
    longDoc.maxSourceChars,
  );
}

function clampChars(value, max) {
  return String(value ?? "").slice(0, max);
}

function truncateWords(value, maxWords) {
  const words = String(value ?? "").split(/\s+/);
  if (words.length <= maxWords) return String(value ?? "");
  return `${words.slice(0, maxWords).join(" ")} …`;
}

function longDocMeta({ mode, pagesTotal, pagesUsed, sections, parts, lost, coverage, notices, fidelityNotice, startedMs, groupId, truncated }) {
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
    partsCount: parts,
    sectionsCount: sections,
    coverage: Number(coverage.toFixed(3)),
    lostRanges: lost.slice(0, 10),
    notices: (notices ?? []).map((notice) => notice.replace(/^> /, "")).slice(0, 5),
    groupId,
    durationMs: Date.now() - startedMs,
  };
}

// ---------------------------------------------------------------------------
// Note persistence (split mode)
// ---------------------------------------------------------------------------

/** Create-or-update the part/overview note by its deterministic id. */
async function upsertNoteForJob({ clerkId, job, note, id, data }) {
  return withUser(clerkId, async (tx) => {
    const existing = await tx.note.findFirst({ where: { id, userId: job.userId }, select: { id: true } });
    if (existing) {
      await tx.note.update({ where: { id }, data });
      return false; // updated
    }
    await tx.note.create({
      data: {
        id,
        userId: job.userId,
        courseId: note.courseId,
        title: data.title ?? "",
        body: data.body ?? "",
        sourceType: "file",
        transcript: data.transcript ?? null,
        summary: data.summary ?? null,
        noteKind: kindOf(job),
        aiState: "ready",
        sourceAssetId: data.sourceAssetId ?? null,
        groupId: data.groupId ?? null,
        partIndex: data.partIndex ?? null,
      },
    });
    return true; // created
  });
}

function kindOf(job) {
  return job.kind === "course_reference" ? "reference" : "note";
}

async function persistPartNote({
  job, note, kind, clerkId, groupId, partIndex, title, body, set, transcript,
  sourceAssetId, fidelity, pagesUsed,
}) {
  const noteId = `part_${job.id}_${partIndex}`;
  const data = {
    title,
    body,
    transcript,
    summary: set?.summaryMarkdown ?? body,
    groupId,
    partIndex,
    sourceAssetId,
  };
  await upsertNoteForJob({ clerkId, job, note, id: noteId, data });
  if (set) {
    // bodyPreserve=true keeps the AI-written part body (lecture notes / refs);
    // for study_set parts the summary markdown becomes the readable body.
    await persistStudySet(
      clerkId,
      { id: noteId, title, userId: job.userId, courseId: note.courseId },
      set,
      kind !== "study_set",
    );
  }
  return noteId;
}

async function persistOverviewNote({
  job, note, kind, clerkId, groupId, overview, summaryList, notices,
  sourceAssetId,
}) {
  const sectionLines = summaryList
    .map((item) => {
      const title = item.section?.title ?? "Section";
      return `- ${title}${item.section?.endPage ? ` (p. ${item.section.startPage ?? "?"}-${item.section.endPage ?? "?"})` : ""}`;
    })
    .join("\n");
  const keyTerms = dedupeTerms(overview);
  const body = [
    ...(notices.length ? notices : []),
    digestToText(overview),
    "",
    "## Sections",
    sectionLines || "- (no sections detected)",
    "",
    "## Key Terms",
    keyTerms.map((term) => `- **${term.term}** — ${term.definition}`).join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  const noteId = `ovw_${job.id}`;
  const title = `${note.title || "Study pack"} — Overview`;
  await upsertNoteForJob({
    clerkId, job, note, id: noteId,
    data: { title, body, summary: digestToText(overview), groupId, partIndex: 0, sourceAssetId },
  });
  // The overview carries no cards/quiz by design (spec 3.7): only its body.
  return noteId;
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
