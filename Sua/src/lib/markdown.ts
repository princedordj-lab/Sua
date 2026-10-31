// Plain-text projection of a markdown body, used wherever a single line of
// preview is wanted (course lists, search results, fallbacks).
export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*>\s+/gm, "")
    .trim();
}

export type MarkdownNotice = string;

/**
 * The pipeline prefixes a note body with "> ..." notice lines (truncated
 * source, unmatched numbers). They belong above the note, styled as notices,
 * not inline in the prose.
 */
export function splitNotices(text: string): {
  notices: MarkdownNotice[];
  body: string;
} {
  const source = String(text ?? "");
  const lines = source.split("\n");
  const notices: MarkdownNotice[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const match = line.match(/^\s*>\s?(.*)$/);
    if (!match) break;
    if (match[1].trim()) notices.push(match[1].trim());
    index += 1;
  }
  if (!notices.length) return { notices: [], body: source.trim() };
  return { notices, body: lines.slice(index).join("\n").trim() };
}

export type MarkdownSection = { heading: string | null; body: string };
export type NoteSection = { id: string; title: string; body: string };
export type ParsedNote = { intro: string; sections: NoteSection[] };

/** Stable, duplicate-safe anchor id for a section heading. */
export function noteSectionSlug(title: string, used?: Set<string>): string {
  const base =
    stripMarkdown(String(title ?? ""))
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 48)
      .replace(/^-+|-+$/g, "") || "section";
  if (!used) return base;
  let slug = base;
  let suffix = 2;
  while (used.has(slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(slug);
  return slug;
}

/**
 * Split a note body into its `##` pages. `#` and `###+` stay inside the
 * current page, fences are respected, and a body with no `##` returns its
 * whole text as `intro` with no sections so the reader can fall back.
 */
export function parseNoteSections(markdown: string): ParsedNote {
  const lines = String(markdown ?? "").split("\n");
  const sections: NoteSection[] = [];
  const used = new Set<string>();
  const intro: string[] = [];
  let current: { title: string; body: string[] } | null = null;
  let fenced = false;
  const flush = () => {
    if (!current) return;
    sections.push({
      id: noteSectionSlug(current.title, used),
      title: current.title,
      body: current.body.join("\n").trim(),
    });
    current = null;
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      (current ? current.body : intro).push(line);
      continue;
    }
    if (!fenced) {
      const match = line.match(/^ {0,3}##\s+(.*?)\s*#*\s*$/);
      if (match) {
        flush();
        const title = stripMarkdown(match[1]).trim() || `Section ${sections.length + 1}`;
        current = { title, body: [] };
        continue;
      }
    }
    (current ? current.body : intro).push(line);
  }
  flush();
  if (!sections.length) return { intro: String(markdown ?? "").trim(), sections: [] };
  return { intro: intro.join("\n").trim(), sections };
}

/** Split a note body on "## " headings so a long note can be read page by page. */
export function splitMarkdownSections(text: string): MarkdownSection[] {
  const { intro, sections } = parseNoteSections(text);
  const result: MarkdownSection[] = [];
  if (intro) result.push({ heading: null, body: intro });
  for (const section of sections) result.push({ heading: section.title, body: section.body });
  return result;
}
