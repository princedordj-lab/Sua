import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Appearance, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import { DefaultTheme, ThemeProvider } from "expo-router";
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
 *
 * Deliberately does NOT call `Appearance.setColorScheme`: every surface in the
 * app is painted from CSS variables, no component uses `dark:` variants, and
 * forcing the native scheme makes AppCompat fire a `uiMode` configuration
 * change on Android. That detaches and re-attaches the react-native-screens
 * fragments mid-render, which used to flash the navigator's default light
 * backdrop (see the `ThemeProvider` below, which removed that surface
 * entirely). Native UI such as `Alert` now follows the OS scheme.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const [pref, setPrefState] = useState<AppearancePref>("system");
  const [loaded, setLoaded] = useState(false);
  const [deviceScheme, setDeviceScheme] = useState<AppearanceScheme>(() =>
    Appearance.getColorScheme() === "dark" ? "dark" : "light",
  );
  // A tap that lands before the stored value resolves must win: the read is
  // only allowed to paint the saved preference, never to undo the user.
  const userChoseRef = useRef(false);

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
        if (!userChoseRef.current && (stored === "light" || stored === "dark")) {
          setPrefState(stored);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [db]);

  // The splash is held by app/_layout.tsx; revealing the first frame only after
  // the saved preference is known avoids a light flash on cold starts with dark
  // saved. Failure still marks loaded, and the timer is a failsafe so a stuck
  // settings read can never pin the splash forever.
  useEffect(() => {
    if (loaded) {
      void SplashScreen.hideAsync().catch(() => {});
      return;
    }
    const timer = setTimeout(() => {
      void SplashScreen.hideAsync().catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
  }, [loaded]);

  const setPref = useCallback(
    async (next: AppearancePref) => {
      userChoseRef.current = true;
      setPrefState(next);
      await setSetting(db, APPEARANCE_KEY, next).catch(() => {});
    },
    [db],
  );

  const scheme = useMemo<AppearanceScheme>(
    () => (pref === "system" ? deviceScheme : pref),
    [pref, deviceScheme],
  );

  const runtimePalette = useMemo(() => palette(scheme), [scheme]);

  // The window/root view behind React. Without this the surface exposed during
  // screen transitions and native repaints is the platform default (white).
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(runtimePalette.cream).catch(() => {});
  }, [runtimePalette.cream]);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      pref,
      setPref,
      loaded,
      scheme,
      runtimePalette,
      varsStyle: scheme === "dark" ? darkVars : lightVars,
    }),
    [pref, setPref, loaded, scheme, runtimePalette],
  );

  // React Navigation (expo-router) otherwise falls back to `DefaultTheme`, and
  // native-stack hands `colors.background` to the native ScreenStack backdrop.
  // That backdrop is not a NativeWind surface, so it stayed `rgb(242,242,242)`
  // in dark mode and showed up as the light flash while screens repainted.
  const navigationTheme = useMemo(
    () => ({
      ...DefaultTheme,
      dark: scheme === "dark",
      colors: {
        ...DefaultTheme.colors,
        primary: runtimePalette.brand.DEFAULT,
        background: runtimePalette.cream,
        card: runtimePalette.surface,
        text: runtimePalette.ink.DEFAULT,
        border: runtimePalette.line,
        notification: runtimePalette.danger,
      },
    }),
    [scheme, runtimePalette],
  );

  return (
    <AppearanceContext.Provider value={value}>
      {/* The variables View cannot use its own variables — className resolution
          reads the *inherited* map, which is the light `:root` default. Paint
          the surface in a child so `bg-cream` picks up the active scheme. */}
      <View style={value.varsStyle} className="flex-1">
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        <ThemeProvider value={navigationTheme}>
          <View className="flex-1 bg-cream">{children}</View>
        </ThemeProvider>
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
