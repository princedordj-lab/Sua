import { useCallback, useEffect, useState } from "react";
import type { SQLiteDatabase } from "expo-sqlite";
import { getSetting, setSetting } from "../lib/notes";

/**
 * Key/value settings live in the SQLite settings table (created in migration
 * 3). Boolean settings default to the behaviour the app shipped with when the
 * row is missing, so a fresh install keeps current behaviour without a
 * backfill.
 */
const DEFAULT_ON: Record<string, boolean> = {
  wifi_only: true,
  auto_generate: true,
  push_enabled: true,
  review_reminder_enabled: false,
};

export function settingOn(key: string, value: string | null): boolean {
  if (value === null) return DEFAULT_ON[key] ?? true;
  return value !== "0";
}

/**
 * A boolean setting that re-renders when it changes. `null` reads as the
 * key's default so the switch is interactive immediately.
 */
export function useBooleanSetting(
  db: SQLiteDatabase,
  key: string,
): {
  value: boolean;
  loaded: boolean;
  update: (next: boolean) => Promise<void>;
} {
  const [value, setValue] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSetting(db, key)
      .then((stored) => {
        if (!cancelled) setValue(stored);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [db, key]);

  const update = useCallback(
    async (next: boolean) => {
      setValue(next ? "1" : "0");
      // Never fatal: a failed write reverts with the next cold start and the
      // gate treats the previous value until then.
      await setSetting(db, key, next ? "1" : "0").catch(() => {});
    },
    [db, key],
  );

  return { value: settingOn(key, value), loaded: value !== null, update };
}

/**
 * A string setting with an explicit fallback while the row is missing (or the
 * read fails). Used for multi-choice preferences like appearance, review
 * length and note text scale.
 */
export function useStringSetting(
  db: SQLiteDatabase,
  key: string,
  fallback: string,
): {
  value: string;
  loaded: boolean;
  update: (next: string) => Promise<void>;
} {
  const [value, setValue] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSetting(db, key)
      .then((stored) => {
        if (!cancelled) setValue(stored);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [db, key]);

  const update = useCallback(
    async (next: string) => {
      setValue(next);
      await setSetting(db, key, next).catch(() => {});
    },
    [db, key],
  );

  return { value: value ?? fallback, loaded: value !== null, update };
}
