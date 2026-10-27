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

export const notePipeline = {
  // A source smaller than this skips the Split/Digest map-reduce entirely.
  shortSourcePages: int("SHORT_SOURCE_PAGES", 15),
  shortSourceMinutes: int("SHORT_SOURCE_MINUTES", 20),
  // Target size of one digest chunk.
  chunkWords: int("CHUNK_WORDS", 3000),
  // Output budget for one digest call. A 3000-word chunk of dense physics needs
  // more than 4096 tokens; a truncated answer is unparseable JSON.
  digestMaxTokens: int("DIGEST_MAX_TOKENS", 8192),
  // Hard cap for one reference sheet (a handout/textbook chapter, not a book).
  // Extraction stops here; generation reads as much text as the 100k-char cap
  // allows. There is no "too long" rejection.
  maxReferencePages: int("MAX_REFERENCE_PAGES", 100),
  // Page cap for a lecture-note upload. Pages past this are reported as
  // truncated so the student can upload the rest by chapter.
  maxNotePages: int("MAX_NOTE_PAGES", 100),
  // Background extraction budget. On expiry the text so far is kept,
  // extractState becomes "partial" and the next pass resumes at extractNextPage.
  extractBudgetMs: int("EXTRACT_BUDGET_MS", 200_000),
  // A "running" asset untouched for this long is treated as crashed and reclaimed.
  extractStaleRunningMs: int("EXTRACT_STALE_RUNNING_MS", 600_000),
  // Only PDF pages with fewer than ocrMinChars go to Gemini OCR.
  ocrConcurrency: int("OCR_CONCURRENCY", 3),
  ocrPageTimeoutMs: int("OCR_PAGE_TIMEOUT_MS", 45_000),
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
