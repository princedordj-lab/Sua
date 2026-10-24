import { colors, palette } from "../config/theme";
import type { Course } from "./types";

// Known course colours map to token tints; unknown server colours fall back to
// the raw value with a translucent tint so any colour renders safely.
const COURSE_STYLES: Record<string, { accent: string; tintKey: keyof typeof colors.courseTint | "success" }> = {
  [colors.course.ocean]: {
    accent: colors.course.ocean,
    tintKey: "ocean",
  },
  [colors.course.forest]: {
    accent: colors.course.forest,
    tintKey: "forest",
  },
  [colors.course.gold]: {
    accent: colors.course.gold,
    tintKey: "gold",
  },
  [colors.course.coral]: {
    accent: colors.course.coral,
    tintKey: "coral",
  },
  [colors.course.violet]: {
    accent: colors.course.violet,
    tintKey: "violet",
  },
  [colors.course.sky]: {
    accent: colors.course.sky,
    tintKey: "sky",
  },
  [colors.course.plum]: {
    accent: colors.course.plum,
    tintKey: "plum",
  },
  [colors.course.slate]: {
    accent: colors.course.slate,
    tintKey: "slate",
  },
  [colors.brand.DEFAULT]: {
    accent: colors.brand.DEFAULT,
    tintKey: "success",
  },
};

export function courseStyle(color: string, theme: ReturnType<typeof palette> = colors) {
  const style = COURSE_STYLES[color];
  if (style) {
    return {
      accent: style.tintKey === "success" ? theme.brand.DEFAULT : theme.course[style.tintKey],
      tint: style.tintKey === "success" ? theme.successSoft : theme.courseTint[style.tintKey],
    };
  }
  return { accent: color, tint: `${color}1F` };
}

export function courseInitials(course: Course) {
  const source = course.code.trim() || course.name.trim();
  return source.slice(0, 2).toUpperCase() || "—";
}
