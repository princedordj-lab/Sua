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

export function palette(scheme: AppearanceScheme) {
  return scheme === "dark" ? darkPalette : colors;
}

export type ThemePalette = ReturnType<typeof palette>;
