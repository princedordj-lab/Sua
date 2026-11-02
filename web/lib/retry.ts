/**
 * KEEP IN STEP with `Sua/src/lib/retry.ts`.
 *
 * The two files are deliberately identical: there is no workspace between the
 * Expo app and the Next app, so a shared package would mean a build pipeline
 * neither has. `web/lib/srs.ts`, `Sua/src/lib/srs.ts` and
 * `backend/src/lib/srs.js` already live by the same rule.
 */

/** The one error body that means "we are full, ask again shortly". */
export const SERVER_BUSY = "SERVER_BUSY";

const DEFAULT_RETRY_MS = 5_000;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

type RetryableError = { code?: string | null; retryAfter?: string | null };

/**
 * Only the capacity 503 is worth a second attempt.
 *
 * A status check would be wrong here: `requirePipeline` answers the *same* 503
 * with "AI processing is not configured" and no `Retry-After`, and waiting five
 * seconds to be told that again is a pure latency tax on a permanent answer. The
 * error code is the server's own distinction between "full" and "cannot work".
 */
export function isRetryable(code?: string | null): boolean {
  return code === SERVER_BUSY;
}

function clamp(ms: number): number {
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, ms));
}

/**
 * `Retry-After` is either seconds or an HTTP-date. The backend sends seconds
 * today; parsing both keeps a client from treating a date as `NaN` and firing
 * immediately at the busiest moment.
 */
export function retryDelayMs(header?: string | null): number {
  const value = (header ?? "").trim();
  if (!value) return DEFAULT_RETRY_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return clamp(seconds * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return DEFAULT_RETRY_MS;
  return clamp(at - Date.now());
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onCancel);
      resolve();
    }, ms);
    function onCancel() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onCancel, { once: true });
    }
  });
}

/**
 * Two attempts, one of them a retry. A `SERVER_BUSY` is answered before the
 * server has done any work — the pool checkout or the transaction start failed —
 * so re-sending cannot duplicate a write, which is what makes retrying a POST
 * here safe rather than a special case to argue about.
 *
 * Everything else is terminal on the first answer: 401 (the session, not the
 * load), other 4xx (the request), 409 (a conflict a retry cannot resolve), and
 * a 503 without the capacity code (a configuration the server will not change).
 */
export async function withRetry<T>(
  run: () => Promise<T>,
  options: { attempts?: number; signal?: AbortSignal; readError?: (cause: unknown) => RetryableError } = {},
): Promise<T> {
  const attempts = options.attempts ?? 2;
  const read = options.readError ?? ((cause: unknown) => (cause ?? {}) as RetryableError);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (cause) {
      if (attempt >= attempts - 1) throw cause;
      const info = read(cause);
      if (!isRetryable(info.code)) throw cause;
      if (options.signal?.aborted) throw cause;
      await wait(retryDelayMs(info.retryAfter), options.signal);
    }
  }
}
