import { colors } from "@/config/theme";

// Course colours are stored as hex in Postgres (mobile writes them). Map the
// eight palette entries to token-driven classes; anything unknown falls back
// to the ocean tint so the UI never invents a colour.
const STYLES = [
  { key: "ocean", hex: colors.course.ocean, dot: "bg-course-ocean", tint: "bg-course-tint-ocean", text: "text-course-ocean" },
  { key: "forest", hex: colors.course.forest, dot: "bg-course-forest", tint: "bg-course-tint-forest", text: "text-course-forest" },
  { key: "gold", hex: colors.course.gold, dot: "bg-course-gold", tint: "bg-course-tint-gold", text: "text-course-gold" },
  { key: "coral", hex: colors.course.coral, dot: "bg-course-coral", tint: "bg-course-tint-coral", text: "text-course-coral" },
  { key: "violet", hex: colors.course.violet, dot: "bg-course-violet", tint: "bg-course-tint-violet", text: "text-course-violet" },
  { key: "sky", hex: colors.course.sky, dot: "bg-course-sky", tint: "bg-course-tint-sky", text: "text-course-sky" },
  { key: "plum", hex: colors.course.plum, dot: "bg-course-plum", tint: "bg-course-tint-plum", text: "text-course-plum" },
  { key: "slate", hex: colors.course.slate, dot: "bg-course-slate", tint: "bg-course-tint-slate", text: "text-course-slate" },
] as const;

export type CourseTheme = (typeof STYLES)[number];

export function courseStyle(colour: string | null | undefined): CourseTheme {
  return (
    STYLES.find((entry) => entry.hex.toLowerCase() === String(colour ?? "").toLowerCase()) ??
    STYLES[0]
  );
}

export function courseInitials(code: string | null | undefined, name: string) {
  const source = code?.trim() || name.trim();
  return source.slice(0, 3).toUpperCase() || "CRS";
}

export const COURSE_COLOURS = STYLES;
