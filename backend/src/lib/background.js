/**
 * Post-response work that the platform actually keeps alive.
 *
 * The old pattern was `async function triggerRunner() { … await import(…) ;
 * waitUntil(run) }` called without `await`. The promise is created, but
 * `waitUntil` is only registered after two dynamic imports have resolved — by
 * which time the response may already be sent and the invocation frozen for
 * reuse. A registered `waitUntil` promise is what tells the platform "keep this
 * invocation alive"; an unawaited promise that registers late is exactly the
 * trap of assuming a floating promise survives the response.
 *
 * So registration is synchronous here: the caller's thunk is wrapped, the
 * promise is registered in the same tick, and only then does the thunk start.
 * Everything after that point is platform-managed.
 *
 * The module is also honest about the two other environments: a long-lived
 * local process keeps the promise alive on its own, and a platform without
 * `waitUntil` gets a floating promise that may be cut short. `runAfterResponse`
 * returns whether the work is actually guaranteed, so a caller can tell the
 * student the truth instead of claiming a job is running.
 */

import { waitUntil as vercelWaitUntil } from "@vercel/functions";

const hasWaitUntil = typeof vercelWaitUntil === "function";

/** Promises registered from this process; exposed for tests and diagnostics. */
const inFlight = new Set();

export function backgroundSupported() {
  return hasWaitUntil;
}

export function pendingBackgroundCount() {
  return inFlight.size;
}

/**
 * Register `thunk` to run after the response, without ever throwing.
 *
 * @param {string} label  short tag for logs ("runner job_x", "extract asset_y")
 * @param {() => unknown | Promise<unknown>} thunk
 * @returns {boolean} true when the platform guarantees the work continues
 */
export function runAfterResponse(label, thunk) {
  let tracked;
  try {
    // Start on the microtask queue so the registration below is still the
    // first thing that happens in this synchronous turn.
    const started = Promise.resolve().then(thunk);
    tracked = started
      .catch((error) => {
        console.warn(`[background] ${label} failed:`, error?.message ?? error);
      })
      .finally(() => {
        inFlight.delete(tracked);
      });
  } catch (error) {
    // Promise.resolve().then() cannot throw synchronously, but a missing
    // implementation of Promise should still not take a request down.
    console.warn(`[background] ${label} could not start:`, error?.message ?? error);
    return false;
  }

  inFlight.add(tracked);

  if (hasWaitUntil) {
    try {
      vercelWaitUntil(tracked);
      return true;
    } catch (error) {
      // `waitUntil` throws outside a request context (unit tests, scripts,
      // the local dev runner). The promise is still tracked; it just has no
      // platform guarantee behind it.
      console.warn(`[background] ${label} not registered with waitUntil:`, error?.message ?? error);
    }
  }

  // A long-lived local process keeps the promise alive; a serverless function
  // without waitUntil does not, and the caller is told so.
  return !process.env.VERCEL;
}
