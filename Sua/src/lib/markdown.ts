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

/** Split a note body on "## " headings so a long note can be read card by card. */
export function splitMarkdownSections(text: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join("\n").trim();
    if (heading || body) sections.push({ heading, body });
    buffer = [];
  };
  for (const line of String(text ?? "").split("\n")) {
    const match = line.match(/^##\s+(.*)$/);
    if (match) {
      flush();
      heading = match[1].trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}
