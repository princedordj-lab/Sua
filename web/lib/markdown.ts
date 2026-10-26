// Port of Sua/src/lib/markdown.ts. Keep behaviour identical so a note reads
// the same on phone and web.

export function stripMarkdown(text: string): string {
  return String(text ?? "")
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

const TRAILING_CITATION = /\s*(\((?:slides?|pp?\.|pages?|about)\s*[^)]*\))\s*$/i;

export function splitTrailingCitation(text: string) {
  const match = text.match(TRAILING_CITATION);
  if (!match) return { text, citation: null as string | null };
  return {
    text: text.slice(0, match.index).trimEnd(),
    citation: match[1],
  };
}

/**
 * The pipeline prefixes a note body with "> ..." notice lines (truncated
 * source, unmatched numbers). They belong above the note, styled as notices,
 * not inline in the prose.
 */
export function splitNotices(text: string): {
  notices: string[];
  body: string;
} {
  const source = String(text ?? "");
  const lines = source.split("\n");
  const notices: string[] = [];
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

// ---------------------------------------------------------------------------
// Editor toolbar transforms. The mobile editor delegates these to its rich
// text component; the web textarea needs explicit string surgery.
// ---------------------------------------------------------------------------

export type Selection = { start: number; end: number };

export function wrapSelection(
  value: string,
  selection: Selection,
  before: string,
  after = before,
): { value: string; selection: Selection } {
  const { start, end } = selection;
  const selected = value.slice(start, end);
  const hasWrapped =
    selected.length > 0 &&
    value.slice(Math.max(0, start - before.length), start) === before &&
    value.slice(end, end + after.length) === after;

  if (hasWrapped) {
    const next = `${value.slice(0, start - before.length)}${selected}${value.slice(end + after.length)}`;
    return {
      value: next,
      selection: { start: start - before.length, end: end - before.length },
    };
  }

  const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
  if (selected.length) {
    return { value: next, selection: { start: start + before.length, end: end + before.length } };
  }
  return { value: next, selection: { start: start + before.length, end: start + before.length } };
}

/** Toggle a line prefix (heading, bullet, numbered) across the touched lines. */
export function toggleLinePrefix(
  value: string,
  selection: Selection,
  prefix: string,
  matcher: RegExp,
): { value: string; selection: Selection } {
  const lineStart = value.lastIndexOf("\n", Math.max(0, selection.start - 1)) + 1;
  const lineEndRaw = value.indexOf("\n", selection.end);
  const lineEnd = lineEndRaw === -1 ? value.length : lineEndRaw;
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const allPrefixed = lines.every((line) => matcher.test(line));
  const next = lines
    .map((line, index) => {
      if (allPrefixed) return line.replace(matcher, "");
      if (prefix === "1. ") return `${index + 1}. ${line.replace(matcher, "")}`;
      return `${prefix}${line.replace(matcher, "")}`;
    })
    .join("\n");
  return {
    value: `${value.slice(0, lineStart)}${next}${value.slice(lineEnd)}`,
    selection: { start: lineStart, end: lineStart + next.length },
  };
}

export const MARKDOWN_PREFIXES = {
  heading: { prefix: "## ", matcher: /^#{1,6}\s+/ },
  bullet: { prefix: "- ", matcher: /^\s*[-*+]\s+/ },
  numbered: { prefix: "1. ", matcher: /^\s*\d+\.\s+/ },
} as const;
