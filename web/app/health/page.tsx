"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

type HealthState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok" }
  | { status: "error"; message: string };

export default function HealthPage() {
  const [state, setState] = useState<HealthState>({ status: "checking" });

  const runCheck = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/health`);
      if (!res.ok) {
        throw new Error(`API responded with HTTP ${res.status}`);
      }
      const body = (await res.json()) as { ok?: unknown };
      if (body.ok !== true) {
        throw new Error("Unexpected health payload");
      }
      setState({ status: "ok" });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Request failed",
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiUrl}/health`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`API responded with HTTP ${res.status}`);
        }
        const body = (await res.json()) as { ok?: unknown };
        if (body.ok !== true) {
          throw new Error("Unexpected health payload");
        }
        setState({ status: "ok" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Request failed",
        });
      });
    return () => controller.abort();
  }, []);

  const retry = useCallback(() => {
    setState({ status: "checking" });
    void runCheck();
  }, [runCheck]);

  const dot = {
    ok: "bg-success",
    error: "bg-danger",
    checking: "bg-gold",
    idle: "bg-ink-faint",
  }[state.status];

  const label = {
    ok: "Backend reachable",
    error: "Backend unreachable",
    checking: "Checking…",
    idle: "Starting…",
  }[state.status];

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-screen text-center">
      <h1 className="text-h2 font-bold">API health</h1>
      <div className="flex w-full max-w-sm flex-col gap-3 rounded-card border border-line bg-surface p-card shadow-card">
        <div className="flex items-center gap-3">
          <span
            className={`${dot} h-3 w-3 shrink-0 rounded-full`}
            role="status"
            aria-label={label}
          />
          <span className="text-body font-semibold">{label}</span>
        </div>
        <dl className="flex flex-col gap-1 text-left text-small text-ink-soft">
          <div className="flex justify-between gap-4">
            <dt className="shrink-0">API base</dt>
            <dd className="truncate font-mono">{apiUrl}</dd>
          </div>
          {state.status === "error" ? (
            <div className="flex justify-between gap-4">
              <dt className="shrink-0">Error</dt>
              <dd className="truncate">{state.message}</dd>
            </div>
          ) : null}
        </dl>
        <button
          type="button"
          onClick={retry}
          disabled={state.status === "checking"}
          className="mt-2 w-full rounded-btn bg-brand py-2.5 text-body font-semibold text-ink-inverse transition-opacity hover:opacity-90 disabled:opacity-45"
        >
          {state.status === "checking" ? "Checking…" : "Retry"}
        </button>
      </div>
      <Link
        href="/"
        className="text-small font-semibold text-ink-soft underline-offset-4 hover:underline"
      >
        Back to home
      </Link>
    </main>
  );
}
