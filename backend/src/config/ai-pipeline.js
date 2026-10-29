/**
 * Note-generation knobs. Every model name, limit and threshold lives here (or
 * in env) so prompt/quality tuning is a config change, never a code change.
 *
 * Prompt versions are stamped into Job.payload metadata and the source hash so
 * changing a prompt invalidates the "identical source" cache and eval results
 * from different prompt versions can be compared.
 */

function int(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function ratio(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

export const PROMPT_VERSION = "notes-v2";

/**
 * Long-source (many-page / many-segment) knobs. Extraction and AI cost caps
 * are HARD safety limits — over the limit the pipeline processes what fits and
 * tells the student exactly what was skipped (never silently clamps). These
 * are per-file caps, not per-plan: plan-enforced billing is a later milestone.
 */
const minutesToMs = (min) => min * 60_000;
export const longDoc = {
  // Above this page/slide count a document goes to split mode (one note per
  // section group plus an overview) unless LONG_DOC_MODE=short would keep it
  // as a single note below LONG_DOC_SPLIT_PAGES.
  splitPages: int("LONG_DOC_SPLIT_PAGES", 40),
  // split | single | short. split = parts generated, single = one layered
  // note with scaled limits, short = below the split threshold.
  mode: process.env.LONG_DOC_MODE === "single" ? "single" : "split",
  // Hard extraction caps. The extractor stops at these bounds and records the
  // skipped range so the student is told.
  maxPages: int("MAX_PAGES", 300),
  maxSourceChars: int("MAX_SOURCE_CHARS", 1_500_000),
  ocrMaxPages: int("OCR_MAX_PAGES", 150),
  ocrMinChars: int("OCR_MIN_CHARS", 40),
  ocrBatchPages: int("OCR_BATCH_PAGES", 4),
  ocrConcurrency: int("OCR_CONCURRENCY", 3),
  extractBudgetMs: int("EXTRACT_BUDGET_MS", 200_000),
  // Chunking (chars, ~2,500 tokens at 4 chars/token). For very large sources
  // the chunk target scales up (up to maxChunkChars) so the map stays around
  // ~90 digest groups instead of burning the call budget on tiny chunks.
  chunkChars: int("CHUNK_CHARS", 10_000),
  maxChunkChars: int("AI_MAX_CHUNK_CHARS", 24_000),
  chunkHardMaxChars: int("CHUNK_HARD_MAX_CHARS", 14_000),
  chunkOverlapChars: int("CHUNK_OVERLAP_CHARS", 200),
  // Map stage.
  aiConcurrency: int("AI_CONCURRENCY", 2),
  maxChunksPerJob: int("MAX_CHUNKS_PER_JOB", 120),
  maxFailedChunkRatio: ratio("MAX_FAILED_CHUNK_RATIO", 0.1),
  maxAiCallsPerJob: int("MAX_AI_CALLS_PER_JOB", 150),
  maxJobRuntimeMin: int("MAX_JOB_RUNTIME_MIN", 45),
  get maxJobRuntimeMs() {
    return minutesToMs(this.maxJobRuntimeMin);
  },
  // Reduce stage.
  reduceMaxChars: int("REDUCE_MAX_CHARS", 40_000),
  reduceGroupSize: int("REDUCE_GROUP_SIZE", 10),
  // Coverage and verification.
  minCoverage: ratio("MIN_COVERAGE", 0.85),
  // Generate-stage word caps for long outputs.
  noteBodyMaxWords: int("NOTE_BODY_MAX_WORDS", 12_000),
};

/**
 * Native document reading: Gemini receives the uploaded PDF itself (text,
 * scans, charts, tables) instead of the server parsing and OCR'ing it page by
 * page. Only documents that are eligible and under quota take this path; every
 * failure falls back to the deterministic extractor in lib/extraction.js.
 */
export const documentRead = {
  // Kill switch: NATIVE_DOC_READ=0 restores the legacy page-wise path.
  enabled: process.env.NATIVE_DOC_READ !== "0",
  // Flash on purpose: Gemini's free tier gives Pro too small a daily quota.
  model: process.env.DOC_READ_MODEL ?? "gemini-3.5-flash",
  // Used when the primary model is overloaded (503) or retired (404).
  fallbackModel: process.env.DOC_READ_FALLBACK_MODEL ?? "gemini-2.5-flash",
  // One read request per file. Longer files use the legacy extractor.
  maxPages: int("DOC_READ_MAX_PAGES", 60),
  // Base64 inflates by ~4/3 and Gemini's inline request cap is ~20MB.
  inlineMaxBytes: int("DOC_READ_INLINE_MAX_BYTES", 14 * 1024 * 1024),
  // Document upload cap; files above inlineMaxBytes go through the Files API.
  maxBytes: int("DOC_READ_MAX_BYTES", 25 * 1024 * 1024),
  timeoutMs: int("DOC_READ_TIMEOUT_MS", 120_000),
  maxOutputTokens: int("DOC_READ_MAX_TOKENS", 32_000),
  // After a 429/quota error, skip Gemini for a while and let every upload be
  // extracted deterministically instead of hammering a closed quota.
  quotaCooldownMs: int("DOC_READ_QUOTA_COOLDOWN_MS", 10 * 60_000),
  // DOCX/PPTX carry no text Gemini can read directly, but their pictures
  // (figures, pasted scans, slide screenshots) are readable. Embedded visuals
  // are read in batches and merged into the slide/section text they belong to.
  embeddedImages: process.env.DOC_READ_EMBEDDED_IMAGES !== "0",
  // Per-file image caps: the free-tier quota is per project, not per app.
  maxEmbeddedImages: int("DOC_READ_MAX_IMAGES", 24),
  imageBatchSize: int("DOC_READ_IMAGE_BATCH", 6),
  // Icons, bullets and logos are noise; real figures and scans are bigger.
  minImageBytes: int("DOC_READ_MIN_IMAGE_BYTES", 6_000),
  maxOutputTokensPerImage: int("DOC_READ_IMAGE_MAX_TOKENS", 1_200),
};

export const notePipeline = {
  // A source smaller than this skips the Split/Digest map-reduce entirely.
  shortSourcePages: int("SHORT_SOURCE_PAGES", 15),
  shortSourceMinutes: int("SHORT_SOURCE_MINUTES", 20),
  // A file whose whole cleaned text fits here also skips map-reduce: one write
  // call sees the entire source. Kept at the study-set material cap so no part
  // of the source is silently dropped between generated artefacts.
  shortSourceChars: int("SHORT_SOURCE_CHARS", 60_000),
  // Target size of one digest chunk.
  chunkWords: int("CHUNK_WORDS", 3000),
  // Output budget for one digest call. A 3000-word chunk of dense physics needs
  // more than 4096 tokens; a truncated answer is unparseable JSON.
  digestMaxTokens: int("DIGEST_MAX_TOKENS", 8192),
  // Hard cap for one reference sheet (a handout/textbook chapter, not a book).
  maxReferencePages: int("MAX_REFERENCE_PAGES", 40),
  // Below this many characters a PDF page is treated as scanned and OCR'd.
  ocrMinChars: int("OCR_MIN_CHARS", 40),
  // A source with less readable text than this cannot produce a note at all;
  // fail with the student-facing message instead of writing an empty note.
  minSourceChars: int("MIN_SOURCE_CHARS", 40),
  // Hard cap on OCR calls for one job: a 200-page scan is not one reference.
  maxOcrPages: int("MAX_OCR_PAGES", 20),
  ocrScale: Number(process.env.OCR_PAGE_SCALE ?? 2) || 2,
  // Output numbers allowed to be absent from the source before a retry.
  maxUnsupportedNumbers: int("MAX_UNSUPPORTED_NUMBERS", 3),
  // One-page reference length.
  referenceMaxWords: int("REFERENCE_MAX_WORDS", 700),
  // Parallel cheap-model digest calls.
  digestConcurrency: int("DIGEST_CONCURRENCY", 3),
  // A line repeated on more than this share of pages is a running header.
  headerFooterPageRatio: ratio("HEADER_FOOTER_PAGE_RATIO", 0.6),
  // Recordings may be run through a cheap "remove filler only" pass. Set
  // AI_CLEANUP_RECORDINGS=0 to rely on the deterministic cleaner alone.
  aiCleanupRecordings: process.env.AI_CLEANUP_RECORDINGS !== "0",
  outputLanguage: process.env.AI_OUTPUT_LANGUAGE ?? "English",
  // Gemini segments are 2 minutes long; used when the model gives no timestamps.
  segmentSeconds: int("RECORDING_SEGMENT_SECONDS", 120),
  // Body safety cap after generation.
  bodyMaxChars: int("NOTE_BODY_MAX_CHARS", 100_000),
  noteMinChars: int("NOTE_MIN_CHARS", 400),
  // Output budget per write call. Lower it for providers/accounts with a
  // smaller per-request cap (the prompt asks for at most one part at a time).
  writeMaxTokens: int("NOTE_MAX_TOKENS", 8192),
  // Output budget for the study set JSON (summary + cards + quiz in one call).
  studySetMaxTokens: int("STUDY_SET_MAX_TOKENS", 8192),
  // Seconds of audio in a reference/note before it counts as "long".
  minutesPerAudioAsset: 2,
};

export const USER_MESSAGES = {
  unreadable: "Couldn't read this file. Try a clearer photo or a text PDF.",
  tooLong:
    "This file is too long for one reference sheet. Upload it by chapter.",
  generic:
    "Something went wrong. Tap to try again. This didn't use your monthly allowance.",
  tooShort:
    "There isn't enough text here to study yet. Add a bit more and try again.",
};

/** An error whose message is safe to show the student verbatim. */
export class UserFacingError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserFacingError";
    this.userFacing = true;
  }
}

export function isUserFacing(error) {
  return Boolean(error?.userFacing);
}

/**
 * The invocation ran out of its time budget mid-pipeline. Not a failure: all
 * finished work is checkpointed, so the runner re-queues the job without
 * spending an attempt and the next invocation resumes where this one stopped.
 * Kept out of the student-facing vocabulary on purpose.
 */
export class JobYieldError extends Error {
  constructor(stage = "run") {
    super(`Job yielded at ${stage}`);
    this.name = "JobYieldError";
    this.yield = true;
    this.stage = stage;
  }
}

export function isJobYield(error) {
  return Boolean(error?.yield);
}
