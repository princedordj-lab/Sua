"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { palette, type AppearanceScheme, type ThemePalette } from "./theme";

export type AppearanceMode = "system" | "light" | "dark";

type AppearanceValue = {
  mode: AppearanceMode;
  scheme: AppearanceScheme;
  setMode: (mode: AppearanceMode) => void;
};

const STORAGE_KEY = "appearance";

const listeners = new Set<() => void>();

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function normalize(raw: string | null): AppearanceMode {
  return raw === "light" || raw === "dark" ? raw : "system";
}

function systemScheme(): AppearanceScheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveScheme(mode: AppearanceMode): AppearanceScheme {
  return mode === "system" ? systemScheme() : mode;
}

function applyScheme(scheme: AppearanceScheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", scheme === "dark");
  root.dataset.theme = scheme;
  root.style.colorScheme = scheme;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", listener);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", listener);
  };
}

function getModeSnapshot(): AppearanceMode {
  return normalize(readRaw());
}

function getModeServerSnapshot(): AppearanceMode {
  return "system";
}

function getSchemeSnapshot(): AppearanceScheme {
  return resolveScheme(getModeSnapshot());
}

function getSchemeServerSnapshot(): AppearanceScheme {
  return "light";
}

const AppearanceContext = createContext<AppearanceValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const mode = useSyncExternalStore(
    subscribe,
    getModeSnapshot,
    getModeServerSnapshot,
  );
  const scheme = useSyncExternalStore(
    subscribe,
    getSchemeSnapshot,
    getSchemeServerSnapshot,
  );

  useEffect(() => {
    applyScheme(scheme);
  }, [scheme]);

  const setMode = useCallback((next: AppearanceMode) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persisting is best-effort; the in-session value still applies.
    }
    for (const listener of listeners) listener();
  }, []);

  const value = useMemo(
    () => ({ mode, scheme, setMode }),
    [mode, scheme, setMode],
  );

  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceValue {
  const value = useContext(AppearanceContext);
  if (!value) {
    throw new Error("useAppearance must be used inside AppearanceProvider");
  }
  return value;
}

export function usePalette(): ThemePalette {
  const { scheme } = useAppearance();
  return palette(scheme);
}
