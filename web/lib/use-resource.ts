"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export type Resource<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  setData: Dispatch<SetStateAction<T | null>>;
};

/**
 * Small fetch-on-mount hook used by every screen. The loader is kept in a ref
 * so callers can pass inline closures without re-triggering the request; the
 * `key` string is the explicit dependency (route id, filter, etc.).
 */
export function useResource<T>(key: string, loader: () => Promise<T>): Resource<T> {
  const loaderRef = useRef(loader);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Keep the latest loader without reading/writing a ref during render. This
  // effect runs before the fetch effect below, so the request always uses the
  // closure from the current commit.
  useEffect(() => {
    loaderRef.current = loader;
  });

  useEffect(() => {
    let active = true;
    loaderRef.current().then(
      (next) => {
        if (!active) return;
        setData(next);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Could not load this page.");
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [key, nonce]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    setNonce((value) => value + 1);
  }, []);

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
