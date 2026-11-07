/**
 * Failure classification for document processing.
 *
 * The processing orchestrator retries a run on transient errors. So the only decision that
 * matters is *what kind of failure* was thrown: a transient one (429, 5xx,
 * network, database capacity) must be thrown so the run is retried with
 * backoff; a permanent one (unsupported file, corrupt file, missing object,
 * unextractable content) must not be retried at all — the stage records it and
 * moves on.
 *
 * Nothing here logs or returns document content, provider keys or prompts.
 */

export const FAILURE_CATEGORY = {
  transient: "transient",
  permanent: "permanent",
};

/** A failure the pipeline must not retry: the input or its content is the problem. */
export class PermanentProcessingError extends Error {
  constructor(message, { code = "PERMANENT", safeMessage = null, cause = null } = {}) {
    super(message);
    this.name = "PermanentProcessingError";
    this.category = FAILURE_CATEGORY.permanent;
    this.code = code;
    // Already written for the student; never a stack trace or provider text.
    this.safeMessage = safeMessage;
    this.cause = cause;
  }
}

/** A failure worth another run (429 / 5xx / network / capacity). */
export class TransientProcessingError extends Error {
  constructor(message, { code = "TRANSIENT", retryAfterMs = null, cause = null } = {}) {
    super(message);
    this.name = "TransientProcessingError";
    this.category = FAILURE_CATEGORY.transient;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.cause = cause;
  }
}

const MAX_RETRY_AFTER_MS = 10 * 60_000;
const MIN_RETRY_AFTER_MS = 2_000;

export function retryAfterFrom(error) {
  const ms = Number(error?.retryAfterMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(ms)));
}

function statusOf(error) {
  const status = Number(error?.status ?? error?.statusCode);
  return Number.isFinite(status) ? status : null;
}

const NETWORK_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Classify any thrown value into a retry decision. */
export function classifyFailure(error) {
  const none = { category: FAILURE_CATEGORY.transient, code: "UNKNOWN", retryAfterMs: null, safeMessage: null, status: null };
  if (!error) return none;
  if (error.category === FAILURE_CATEGORY.permanent || error.category === FAILURE_CATEGORY.transient) {
    return {
      category: error.category,
      code: error.code ?? "ERROR",
      retryAfterMs: retryAfterFrom(error),
      safeMessage: error.safeMessage ?? null,
      status: statusOf(error),
    };
  }

  // UserFacingError is used for invalid or insufficient source content. The
  // message is already safe for the student, and retrying the same bytes cannot
  // make that content readable.
  if (error.userFacing) {
    return {
      category: FAILURE_CATEGORY.permanent,
      code: "UNUSABLE_SOURCE",
      retryAfterMs: null,
      safeMessage: String(error.message ?? "This source could not be read."),
      status: statusOf(error),
    };
  }

  const status = statusOf(error);
  const kind = typeof error.kind === "string" ? error.kind : null;
  const message = String(error?.message ?? "").toLowerCase();
  const transient = (code) => ({ category: "transient", code, retryAfterMs: retryAfterFrom(error), safeMessage: null, status });
  const permanent = (code, safeMessage) => ({ category: "permanent", code, retryAfterMs: null, safeMessage, status });

  // Typed AI errors (lib/ai.js AiError): the provider decides the policy.
  if (kind === "rate_limit") return transient("AI_RATE_LIMIT");
  if (kind === "timeout") return transient("AI_TIMEOUT");
  if (kind === "transient") return transient("AI_TRANSIENT");
  if (kind === "checkpoint_write") return transient("CHECKPOINT_WRITE");
  if (kind === "auth") return permanent("AI_AUTH", "Study generation is temporarily unavailable. Please try again later.");
  if (kind === "quota") return permanent("AI_QUOTA", "Study generation is temporarily unavailable (AI quota reached). Please try again later.");
  if (kind === "bad_request") return permanent("AI_BAD_REQUEST", "This material could not be generated. Please try again later.");
  if (kind === "invalid_output") return permanent("AI_INVALID_OUTPUT", "The AI returned an unusable response for this material. Tap Try again.");
  if (kind === "too_large") return permanent("AI_TOO_LARGE", "This material is too long for one AI request. Upload it in chapters.");
  if (kind === "cancel") return permanent("CANCELLED", null);

  // HTTP statuses from any other provider call.
  if (status === 429) return transient("HTTP_429");
  if (status && status >= 500) return transient(`HTTP_${status}`);
  if (status === 408) return transient("HTTP_408");
  if (status && status >= 400) return permanent(`HTTP_${status}`, null);

  if (NETWORK_CODES.has(String(error?.code ?? ""))) return transient("NETWORK");
  if (/fetch failed|network error|socket hang up|timed out|timeout/.test(message)) return transient("NETWORK");

  // Neon pool / Prisma interactive-transaction window: this is capacity, not a defect.
  if (
    error?.code === "P2028" ||
    error?.code === "P1001" ||
    error?.code === "P1008" ||
    error?.code === "P1017" ||
    /unable to start a transaction|expired transaction|timeout exceeded when trying to connect/.test(message)
  ) {
    return transient("DB_CAPACITY");
  }
  if (error?.code === "P2025" || error?.name === "NoteDeletedError") return permanent("NOTE_DELETED", null);
  if (error?.yield === true) return transient("YIELD");

  return transient("UNEXPECTED");
}

export function isTransientFailure(error) {
  return classifyFailure(error).category === FAILURE_CATEGORY.transient;
}

/** The message the student may see. Never provider text, never a stack trace. */
export function safeFailureMessage(
  error,
  fallback = "Something went wrong while preparing this note. Tap Try again.",
) {
  const classified = classifyFailure(error);
  if (classified.safeMessage) return classified.safeMessage;
  const message = String(error?.message ?? "");
  // Only messages written for the student pass through (UserFacingError sets `userFacing`).
  if (error?.userFacing && message) return message;
  return fallback;
}
