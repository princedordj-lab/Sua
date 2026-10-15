import { colors } from "../config/theme";
import type { Course } from "./types";

// Known course colours map to token tints; unknown server colours fall back to
// the raw value with a translucent tint so any colour renders safely.
const COURSE_STYLES: Record<string, { accent: string; tint: string }> = {
  [colors.course.ocean]: {
    accent: colors.course.ocean,
    tint: colors.courseTint.ocean,
  },
  [colors.course.forest]: {
    accent: colors.course.forest,
    tint: colors.courseTint.forest,
  },
  [colors.course.gold]: {
    accent: colors.course.gold,
    tint: colors.courseTint.gold,
  },
  [colors.course.coral]: {
    accent: colors.course.coral,
    tint: colors.courseTint.coral,
  },
  [colors.course.violet]: {
    accent: colors.course.violet,
    tint: colors.courseTint.violet,
  },
  [colors.course.sky]: {
    accent: colors.course.sky,
    tint: colors.courseTint.sky,
  },
  [colors.course.plum]: {
    accent: colors.course.plum,
    tint: colors.courseTint.plum,
  },
  [colors.course.slate]: {
    accent: colors.course.slate,
    tint: colors.courseTint.slate,
  },
  [colors.brand.DEFAULT]: {
    accent: colors.brand.DEFAULT,
    tint: colors.successSoft,
  },
};

export function courseStyle(color: string) {
  return COURSE_STYLES[color] ?? { accent: color, tint: `${color}1F` };
}

export function courseInitials(course: Course) {
  const source = course.code.trim() || course.name.trim();
  return source.slice(0, 2).toUpperCase() || "—";
}
