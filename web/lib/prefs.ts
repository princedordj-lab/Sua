"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { NoteTextScale } from "./types";

export type SummaryLength = "short" | "standard" | "detailed";

export type Prefs = {
  reviewSessionLength: number;
  noteTextScale: NoteTextScale;
  rememberCaptureCourse: boolean;
  summaryLength: SummaryLength;
  lastCourseId: string | null;
};

export const DEFAULT_PREFS: Prefs = {
  reviewSessionLength: 30,
  noteTextScale: "medium",
  rememberCaptureCourse: true,
  summaryLength: "standard",
  lastCourseId: null,
};

const STORAGE_KEY = "sua.prefs";
const listeners = new Set<() => void>();
let cache: Prefs | null = null;

function clampLength(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PREFS.reviewSessionLength;
  return Math.min(50, Math.max(5, Math.round(parsed)));
}

function read(): Prefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      reviewSessionLength: clampLength(parsed.reviewSessionLength),
      noteTextScale:
        parsed.noteTextScale === "small" || parsed.noteTextScale === "large"
          ? parsed.noteTextScale
          : "medium",
      rememberCaptureCourse:
        typeof parsed.rememberCaptureCourse === "boolean"
          ? parsed.rememberCaptureCourse
          : true,
      summaryLength:
        parsed.summaryLength === "short" || parsed.summaryLength === "detailed"
          ? parsed.summaryLength
          : "standard",
      lastCourseId:
        typeof parsed.lastCourseId === "string" ? parsed.lastCourseId : null,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function getSnapshot(): Prefs {
  if (!cache) cache = read();
  return cache;
}

function getServerSnapshot(): Prefs {
  return DEFAULT_PREFS;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cache = read();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function updatePrefs(patch: Partial<Prefs>) {
  const next = { ...getSnapshot(), ...patch };
  next.reviewSessionLength = clampLength(next.reviewSessionLength);
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Persisting is best-effort; the session keeps the new value.
  }
  for (const listener of listeners) listener();
}

export function usePrefs() {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const update = useCallback((patch: Partial<Prefs>) => updatePrefs(patch), []);
  return { prefs, update };
}

export const NOTE_TEXT_SIZE: Record<NoteTextScale, number> = {
  small: 14,
  medium: 16,
  large: 20,
};
