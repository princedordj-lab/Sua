import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Appearance, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useColorScheme as useNativeWindColorScheme } from "nativewind";
import { useSQLiteContext } from "expo-sqlite";
import { getSetting, setSetting } from "../lib/notes";
import {
  darkVars,
  lightVars,
  palette,
  type AppearanceScheme,
} from "../config/theme";

export type AppearancePref = "system" | "light" | "dark";

const APPEARANCE_KEY = "appearance";

type AppearanceContextValue = {
  /** What the user picked in Preferences; "system" follows the device. */
  pref: AppearancePref;
  setPref: (next: AppearancePref) => Promise<void>;
  /** False until the persisted preference is read from the settings table. */
  loaded: boolean;
  /** The scheme actually being rendered right now. */
  scheme: AppearanceScheme;
  /** Resolved JS-side colors (icons, style objects, tab bar). */
  runtimePalette: ReturnType<typeof palette>;
  /** CSS-variable style for the app root wrapper. */
  varsStyle: typeof lightVars;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

/**
 * Applies the appearance preference across the app.
 *
 * Neutrals are CSS variables remapped by wrapping the root in a View whose
 * style is the scheme's `vars()` map (see config/theme.ts). The preference
 * lives in the device-local settings table; "system" follows the device and
 * re-renders when the OS switches schemes.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const nativewindScheme = useNativeWindColorScheme();
  const [pref, setPrefState] = useState<AppearancePref>("system");
  const [loaded, setLoaded] = useState(false);
  const [deviceScheme, setDeviceScheme] = useState<AppearanceScheme>(() =>
    Appearance.getColorScheme() === "dark" ? "dark" : "light",
  );

  useEffect(() => {
    const subscription = Appearance.addChangeListener((state) => {
      setDeviceScheme(state.colorScheme === "dark" ? "dark" : "light");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSetting(db, APPEARANCE_KEY)
      .then((stored) => {
        if (cancelled) return;
        if (stored === "light" || stored === "dark") setPrefState(stored);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [db]);

  const setPref = useCallback(
    async (next: AppearancePref) => {
      setPrefState(next);
      await setSetting(db, APPEARANCE_KEY, next).catch(() => {});
    },
    [db],
  );

  // Keep NativeWind's scheme in sync for `dark:` variants and any future
  // daughter hooks; "system" resets it to follow the device.
  useEffect(() => {
    nativewindScheme.setColorScheme(loaded ? pref : "system");
  }, [nativewindScheme, loaded, pref]);

  const scheme = useMemo<AppearanceScheme>(
    () => (pref === "system" ? deviceScheme : pref),
    [pref, deviceScheme],
  );

  const value = useMemo<AppearanceContextValue>(
    () => ({
      pref,
      setPref,
      loaded,
      scheme,
      runtimePalette: palette(scheme),
      varsStyle: scheme === "dark" ? darkVars : lightVars,
    }),
    [pref, setPref, loaded, scheme],
  );

  return (
    <AppearanceContext.Provider value={value}>
      <View style={value.varsStyle} className="flex-1">
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        {children}
      </View>
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) {
    throw new Error("useAppearance must be used inside AppearanceProvider.");
  }
  return value;
}

/** Convenience: just the resolved palette for JS-side colors. */
export function usePalette(): ReturnType<typeof palette> {
  const { runtimePalette } = useAppearance();
  return runtimePalette;
}
