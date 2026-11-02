"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { registerResource } from "./bus";

export type Resource<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  setData: Dispatch<SetStateAction<T | null>>;
};

/**
 * A tab left open on /app/study is not stale for 30 seconds, it is stale the
 * moment the phone grades a card. Fetch-on-mount cannot know that, so every
 * screen also re-asks when the tab becomes visible again — the cheapest signal
 * that the student has been somewhere else. Half a minute of grace keeps a
 * focus-chasing student (alt-tab, back, alt-tab) from stampeding the pool.
 */
const STALE_MS = 30_000;

/**
 * A capacity 503 carries `Retry-After`, and the only honest answer is to ask
 * again then. Bounded, because a route that fails for a reason that is not
 * capacity would otherwise retry forever behind a screen that says "retrying".
 */
const MAX_AUTO_RETRIES = 3;

/**
 * Small fetch-on-mount hook used by every screen. The loader is kept in a ref
 * so callers can pass inline closures without re-triggering the request; the
 * `key` string is the explicit dependency (route id, filter, etc.) — and the
 * address the invalidation bus uses to reach this screen.
 */
export function useResource<T>(key: string, loader: () => Promise<T>): Resource<T> {
  const loaderRef = useRef(loader);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const hasDataRef = useRef(false);
  const loadedAtRef = useRef(0);
  const autoRetriesRef = useRef(0);
  // Requests are numbered per hook instance, so a response that arrives after a
  // newer one was issued cannot land. Focus refetches make that overlap routine:
  // the same key can now have two requests in flight, and the older one is wrong.
  const seqRef = useRef(0);

  // Keep the latest loader without reading/writing a ref during render. This
  // effect runs before the fetch effect below, so the request always uses the
  // closure from the current commit.
  useEffect(() => {
    loaderRef.current = loader;
  });

  useEffect(() => {
    const requestId = ++seqRef.current;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    loaderRef.current().then(
      (next) => {
        if (!active || requestId !== seqRef.current) return;
        setData(next);
        setError(null);
        setLoading(false);
        hasDataRef.current = true;
        loadedAtRef.current = Date.now();
        autoRetriesRef.current = 0;
      },
      (cause: unknown) => {
        if (!active || requestId !== seqRef.current) return;
        setError(cause instanceof Error ? cause.message : "Could not load this page.");
        setLoading(false);
        loadedAtRef.current = 0;
        const retryAtMs = (cause as { retryAtMs?: number } | undefined)?.retryAtMs;
        if (retryAtMs && autoRetriesRef.current < MAX_AUTO_RETRIES) {
          autoRetriesRef.current += 1;
          timer = setTimeout(() => {
            if (active) setNonce((value) => value + 1);
          }, retryAtMs);
        }
      },
    );

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [key, nonce]);

  const reload = useCallback(() => {
    // A background refresh must not blank the screen it is about to replace.
    if (!hasDataRef.current) setLoading(true);
    setError(null);
    setNonce((value) => value + 1);
  }, []);

  // Mounted screens are reachable by name, so a mutation anywhere can refetch
  // exactly the data it changed instead of waiting for a remount.
  useEffect(() => registerResource(key, reload), [key, reload]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - loadedAtRef.current > STALE_MS) reload();
    }
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  return { data, loading, error, reload, setData };
}

export function useMutation<Input, Output>(
  run: (input: Input) => Promise<Output>,
) {
  const runRef = useRef(run);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    runRef.current = run;
  });

  const mutate = useCallback(async (input: Input): Promise<Output | null> => {
    setBusy(true);
    setError(null);
    try {
      return await runRef.current(input);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return { mutate, busy, error, setError };
}

export function errorMessage(cause: unknown) {
  if (cause instanceof Error && cause.message) return cause.message;
  return "Something went wrong. Please try again.";
}
