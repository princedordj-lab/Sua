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
    strong: "#005B45",
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
  hero: "rounded-card bg-brand-strong p-card-lg",
  button: "min-h-12 items-center justify-center rounded-btn px-5",
  buttonPrimary:
    "min-h-12 items-center justify-center rounded-btn bg-gold px-5 shadow-gold",
  buttonSecondary:
    "min-h-12 items-center justify-center rounded-btn bg-brand-strong px-5",
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
 * Scheme-aware neutral, brand and status roles are driven through CSS
 * variables declared in tailwind.config.js. `darkVars` remaps those roles, so
 * token-based classes follow the appearance preference without `dark:` variants.
 * Inverse ink stays white for controls on coloured surfaces.
 */
export const lightVars = vars({
  "--color-cream": "255 248 232",
  "--color-surface": "255 255 255",
  "--color-ink": "14 31 24",
  "--color-ink-soft": "92 107 99",
  "--color-ink-faint": "138 151 143",
  "--color-line": "232 224 201",
  "--color-brand": "0 91 69",
  "--color-brand-light": "8 122 91",
  "--color-brand-strong": "0 91 69",
  "--color-gold": "255 190 26",
  "--color-gold-soft": "255 241 191",
  "--color-success": "30 158 106",
  "--color-danger": "214 69 69",
  "--color-warning": "232 135 14",
  "--color-info": "47 125 209",
  "--color-success-soft": "232 247 240",
  "--color-danger-soft": "252 236 236",
  "--color-warning-soft": "255 243 225",
  "--color-info-soft": "234 243 252",
  "--color-rating-again": "174 39 39",
  "--color-rating-hard": "153 78 0",
  "--color-rating-good": "0 91 69",
  "--color-rating-easy": "126 86 0",
  "--color-course-violet-tint": "240 237 252",
});

export const darkVars = vars({
  // Warm charcoal — Sua's cream/ink roles swap onto dark, warm surfaces.
  "--color-cream": "23 20 17",
  "--color-surface": "33 29 24",
  "--color-ink": "241 235 221",
  "--color-ink-soft": "181 170 152",
  "--color-ink-faint": "167 157 140",
  "--color-line": "55 50 42",
  "--color-brand": "37 168 127",
  "--color-brand-light": "0 91 69",
  "--color-brand-strong": "0 91 69",
  "--color-gold": "255 204 72",
  "--color-gold-soft": "74 59 24",
  "--color-success": "77 207 151",
  "--color-danger": "255 123 123",
  "--color-warning": "247 184 94",
  "--color-info": "116 177 240",
  "--color-success-soft": "27 56 43",
  "--color-danger-soft": "62 34 34",
  "--color-warning-soft": "63 47 25",
  "--color-info-soft": "30 47 64",
  "--color-rating-again": "130 35 35",
  "--color-rating-hard": "126 62 0",
  "--color-rating-good": "0 78 58",
  "--color-rating-easy": "104 70 0",
  "--color-course-violet-tint": "48 42 72",
});

export type AppearanceScheme = "light" | "dark";

export const darkPalette = {
  ...colors,
  brand: { DEFAULT: "#25A87F", light: "#005B45", strong: "#005B45" },
  gold: { DEFAULT: "#FFCC48", soft: "#4A3B18" },
  success: "#4DCF97",
  danger: "#FF7B7B",
  warning: "#F7B85E",
  info: "#74B1F0",
  successSoft: "#1B382B",
  dangerSoft: "#3E2222",
  warningSoft: "#3F2F19",
  infoSoft: "#1E2F40",
  rating: { again: "#822323", hard: "#7E3E00", good: "#004E3A", easy: "#684600" },
  course: {
    ocean: "#73B3F3", forest: "#4DCF97", gold: "#FFCC48", coral: "#FF9287",
    violet: "#A496FF", sky: "#73CEEC", plum: "#E091D2", slate: "#A9B3AD",
  },
  courseTint: {
    ocean: "#1E2F40", forest: "#1B382B", gold: "#4A3B18", coral: "#422925",
    violet: "#302A48", sky: "#1D3540", plum: "#3D293B", slate: "#2C322F",
  },
  cream: "#171411",
  surface: "#211D18",
  line: "#37322A",
  ink: {
    ...colors.ink,
    DEFAULT: "#F1EBDD",
    soft: "#B5AA98",
    faint: "#A79D8C",
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
