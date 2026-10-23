import type { ViewStyle } from "react-native";
import { vars } from "nativewind";

/**
 * Sua's visual source of truth.
 *
 * Keep component styling in NativeWind classes. Use these values for things
 * NativeWind cannot express cleanly, such as icon colours and safe areas.
 */
export const colors = {
  cream: "#FFF8E8",
  surface: "#FFFFFF",
  brand: {
    DEFAULT: "#005B45",
    light: "#087A5B",
  },
  gold: {
    DEFAULT: "#FFBE1A",
    soft: "#FFF1BF",
  },
  ink: {
    DEFAULT: "#0E1F18",
    soft: "#5C6B63",
    faint: "#8A978F",
    inverse: "#FFFFFF",
  },
  line: "#E8E0C9",
  success: "#1E9E6A",
  danger: "#D64545",
  warning: "#E8870E",
  info: "#2F7DD1",
  successSoft: "#E8F7F0",
  dangerSoft: "#FCECEC",
  warningSoft: "#FFF3E1",
  infoSoft: "#EAF3FC",
  rating: {
    again: "#D64545",
    hard: "#E8870E",
    good: "#1E9E6A",
    easy: "#FFBE1A",
  },
  course: {
    ocean: "#2F7DD1",
    forest: "#1E9E6A",
    gold: "#FFBE1A",
    coral: "#E8796F",
    violet: "#7966D8",
    sky: "#56B4D9",
    plum: "#A45A9B",
    slate: "#65746D",
  },
  courseTint: {
    ocean: "#EAF3FC",
    forest: "#E8F7F0",
    gold: "#FFF3CC",
    coral: "#FCEBE9",
    violet: "#F0EDFC",
    sky: "#EAF8FC",
    plum: "#F7ECF5",
    slate: "#EEF1EF",
  },
} as const;

export const fontFamily = {
  sans: "PlusJakartaSans_400Regular",
  "sans-medium": "PlusJakartaSans_500Medium",
  "sans-semibold": "PlusJakartaSans_600SemiBold",
  "sans-bold": "PlusJakartaSans_700Bold",
  "sans-extrabold": "PlusJakartaSans_800ExtraBold",
} as const;

export const fontSize = {
  h1: ["28px", { lineHeight: "34px" }],
  h2: ["26px", { lineHeight: "32px" }],
  h3: ["22px", { lineHeight: "28px" }],
  title: ["20px", { lineHeight: "26px" }],
  "body-lg": ["17px", { lineHeight: "24px" }],
  body: ["15px", { lineHeight: "22px" }],
  label: ["14px", { lineHeight: "20px" }],
  small: ["13px", { lineHeight: "18px" }],
  caption: ["12px", { lineHeight: "16px" }],
  display: ["40px", { lineHeight: "44px" }],
  timer: ["56px", { lineHeight: "60px" }],
} as const;

export const spacing = {
  screen: "20px",
  card: "16px",
  "card-lg": "20px",
  section: "28px",
  tabbar: "104px",
} as const;

export const borderRadius = {
  card: "28px",
  btn: "20px",
  tile: "20px",
  input: "16px",
  chip: "9999px",
  sheet: "32px",
} as const;

export const boxShadow = {
  card: "0 4px 20px rgba(14, 31, 24, 0.06)",
  float: "0 8px 28px rgba(14, 31, 24, 0.14)",
  gold: "0 6px 18px rgba(249, 185, 31, 0.28)",
  glow: "0 0 24px rgba(249, 185, 31, 0.24)",
} as const;

export const gradients = {
  hero: [colors.brand.DEFAULT, colors.brand.light] as const,
  recording: ["#063D30", colors.brand.DEFAULT] as const,
  celebration: [colors.brand.light, colors.brand.DEFAULT] as const,
} as const;

export const motion = {
  duration: { fast: 120, base: 220, slow: 360 },
  spring: { damping: 18, stiffness: 180 },
  pressScale: 0.97,
  disabledOpacity: 0.45,
} as const;

export const ui = {
  screen: "flex-1 bg-cream px-screen pb-tabbar",
  card: "rounded-card bg-surface p-card shadow-card",
  cardLarge: "rounded-card bg-surface p-card-lg shadow-card",
  hero: "rounded-card bg-brand p-card-lg",
  button: "min-h-12 items-center justify-center rounded-btn px-5",
  buttonPrimary:
    "min-h-12 items-center justify-center rounded-btn bg-gold px-5 shadow-gold",
  buttonSecondary:
    "min-h-12 items-center justify-center rounded-btn bg-brand px-5",
  input:
    "h-12 rounded-input border border-line bg-surface px-4 text-body text-ink",
  chip: "rounded-chip px-3 py-2",
  tabBar: "rounded-sheet bg-surface px-4 shadow-float",
  sectionGap: "gap-section",
} as const;

export const safeAreaStyle: ViewStyle = {
  flex: 1,
  backgroundColor: colors.cream,
};

export const safeAreaStyleDark: ViewStyle = {
  flex: 1,
  backgroundColor: "#063D30",
};

/**
 * Appearance tokens.
 *
 * The 6 scheme-reactive neutrals are driven through CSS variables declared in
 * tailwind.config.js; `lightVars` mirrors the `addBase` light defaults and
 * `darkVars` re-maps them, so every `bg-cream`/`text-ink`/`bg-surface`/
 * `text-ink-soft`/`text-ink-faint`/`border-line` class in the app follows the
 * preference without any `dark:` variants. Accent colours (brand, gold,
 * success, …) and `ink.inverse` intentionally stay static: they sit on
 * coloured/gold surfaces that do not invert.
 */
export const lightVars = vars({
  "--color-cream": "255 248 232",
  "--color-surface": "255 255 255",
  "--color-ink": "14 31 24",
  "--color-ink-soft": "92 107 99",
  "--color-ink-faint": "138 151 143",
  "--color-line": "232 224 201",
});

export const darkVars = vars({
  // Warm charcoal — Sua's cream/ink roles swap onto dark, warm surfaces.
  "--color-cream": "23 20 17",
  "--color-surface": "33 29 24",
  "--color-ink": "241 235 221",
  "--color-ink-soft": "181 170 152",
  "--color-ink-faint": "135 125 108",
  "--color-line": "55 50 42",
});

export type AppearanceScheme = "light" | "dark";

export const darkPalette = {
  ...colors,
  cream: "#171411",
  surface: "#211D18",
  line: "#37322A",
  ink: {
    ...colors.ink,
    DEFAULT: "#F1EBDD",
    soft: "#B5AA98",
    faint: "#877D6C",
  },
} as const;

/** Runtime palette for JS consumers (icon colors, style objects, tab bar). */
export function palette(scheme: AppearanceScheme) {
  return scheme === "dark" ? darkPalette : colors;
}

export const tokens = {
  colors,
  fontFamily,
  fontSize,
  spacing,
  borderRadius,
  boxShadow,
  gradients,
  motion,
  safeAreaStyle,
  safeAreaStyleDark,
} as const;

export type ThemeTokens = typeof tokens;
