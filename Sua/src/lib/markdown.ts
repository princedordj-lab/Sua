// Markdown helpers for the note editor.
//
// The body is stored as plain markdown; the toolbar applies the formatting it
// advertises (bold, italic, headings, lists) and every edit is expressed as a
// set of text operations in *original* coordinates so the resulting selection
// can be mapped precisely — including the difference between a selection that
// starts at an inserted marker (must sit after it) and one that ends there
// (must stay before it).

export type MarkdownTool = "bold" | "italic" | "heading" | "bullet" | "numbered";

export type MarkdownEdit = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

type Op = {
  // Inclusive start, exclusive end, in the original string's coordinates.
  start: number;
  end: number;
  replacement: string;
};

type LineInfo = { start: number; end: number; content: string };

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function lineStartAt(text: string, pos: number) {
  if (pos <= 0) return 0;
  return text.lastIndexOf("\n", pos - 1) + 1;
}

function lineEndAt(text: string, pos: number) {
  const idx = text.indexOf("\n", pos);
  return idx === -1 ? text.length : idx;
}

function collectLines(text: string, start: number, end: number): LineInfo[] {
  const lines: LineInfo[] = [];
  let cursor = lineStartAt(text, start);
  for (;;) {
    // A selection ending exactly on a line boundary does not cover the next
    // line's content.
    if (cursor > start && cursor === end) break;
    const lineEnd = lineEndAt(text, cursor);
    lines.push({ start: cursor, end: lineEnd, content: text.slice(cursor, lineEnd) });
    if (lineEnd >= text.length) break;
    cursor = lineEnd + 1;
    if (cursor > end) break;
  }
  return lines;
}

function applyOps(text: string, ops: Op[]): string {
  const sorted = [...ops].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let last = 0;
  for (const op of sorted) {
    if (op.start < last) continue;
    out += text.slice(last, op.start) + op.replacement;
    last = Math.max(last, op.end);
  }
  return out + text.slice(last);
}

// Maps an original position onto its position after the ops are applied.
// `bias` matters for pure insertions sitting exactly at the position: a
// selection start moves after the inserted text, an end stays before it.
function mapPos(pos: number, ops: Op[], bias: "start" | "end"): number {
  const sorted = [...ops].sort((a, b) => a.start - b.start || a.end - b.end);
  let acc = 0;
  for (const op of sorted) {
    const removed = op.end - op.start;
    const inserted = op.replacement.length;
    if (pos < op.start) break;
    if (bias === "end" && removed === 0 && pos === op.start) continue;
    const newStart = op.start + acc;
    if (pos <= op.end) {
      const off = pos - op.start;
      const local =
        removed === 0
          ? off + inserted
          : off < removed
            ? Math.min(off, inserted)
            : off - removed + inserted;
      return newStart + local;
    }
    acc += inserted - removed;
  }
  return pos + acc;
}

function isSurrounded(text: string, start: number, end: number, marker: string) {
  if (start < marker.length || end + marker.length > text.length) return false;
  if (text.slice(start - marker.length, start) !== marker) return false;
  if (text.slice(end, end + marker.length) !== marker) return false;
  if (marker === "*") {
    // A single "*" abutting another star is the inner half of "**" (bold) —
    // unwrapping it would silently un-bold the text.
    if (text[start - marker.length - 1] === "*") return false;
    if (text[end + marker.length] === "*") return false;
  }
  return true;
}

function wrapOps(text: string, start: number, end: number, marker: string): Op[] {
  if (marker === "*") {
    // ***bold italic*** → toggle the italic off, leaving the bold intact.
    if (
      start >= 3 &&
      end + 3 <= text.length &&
      text.slice(start - 3, start) === "***" &&
      text.slice(end, end + 3) === "***"
    ) {
      return [
        { start: start - 1, end: start, replacement: "" },
        { start: end, end: end + 1, replacement: "" },
      ];
    }
  }
  if (start === end) {
    // Empty selection: drop the cursor between the markers.
    return [
      { start, end: start, replacement: marker },
      { start, end: start, replacement: marker },
    ];
  }
  if (isSurrounded(text, start, end, marker)) {
    return [
      { start: start - marker.length, end: start, replacement: "" },
      { start: end, end: end + marker.length, replacement: "" },
    ];
  }
  return [
    { start, end: start, replacement: marker },
    { start: end, end, replacement: marker },
  ];
}

function linePrefixOps(text: string, start: number, end: number, match: RegExp, prefix: string): Op[] {
  return collectLines(text, start, end).flatMap((line) => {
    const found = line.content.match(match);
    if (found) {
      return [{ start: line.start, end: line.start + found[0].length, replacement: "" }];
    }
    return [{ start: line.start, end: line.start, replacement: prefix }];
  });
}

function numberMatch(content: string) {
  return content.match(/^(\s*)(\d+)\.\s+/);
}

function numberedOps(text: string, start: number, end: number): Op[] {
  const lines = collectLines(text, start, end);
  if (!lines.length) return [];

  if (numberMatch(lines[0].content)) {
    // Toggle off: strip the numbering from the selected lines.
    return lines.flatMap((line) => {
      const found = numberMatch(line.content);
      if (!found) return [];
      return [{ start: line.start, end: line.start + found[0].length, replacement: "" }];
    });
  }

  // Number the selected lines and renumber every adjacent numbered line, so
  // the whole block reads 1..n top to bottom.
  const selected = new Set(lines.map((line) => line.start));
  const region: LineInfo[] = [];

  let cursor = lines[0].start;
  while (cursor > 0) {
    const prevStart = cursor >= 2 ? text.lastIndexOf("\n", cursor - 2) + 1 : 0;
    const prevEnd = lineEndAt(text, prevStart);
    const content = text.slice(prevStart, prevEnd);
    if (!numberMatch(content)) break;
    region.unshift({ start: prevStart, end: prevEnd, content });
    if (prevStart === 0) break;
    cursor = prevStart;
  }

  region.push(...lines);

  const lastLine = lines[lines.length - 1];
  if (lastLine.end < text.length) {
    let nextStart = lastLine.end + 1;
    while (nextStart <= text.length) {
      const nextEnd = lineEndAt(text, nextStart);
      const content = text.slice(nextStart, nextEnd);
      if (!numberMatch(content)) break;
      region.push({ start: nextStart, end: nextEnd, content });
      if (nextEnd >= text.length) break;
      nextStart = nextEnd + 1;
    }
  }

  const ops: Op[] = [];
  let counter = 0;
  for (const line of region) {
    const inSelection = selected.has(line.start);
    const found = numberMatch(line.content);
    if (!inSelection && !found) {
      counter = 0;
      continue;
    }
    counter += 1;
    const leading = found ? found[1] : "";
    const replacement = `${leading}${counter}. `;
    if (found) {
      if (found[0] === replacement) continue;
      ops.push({ start: line.start, end: line.start + found[0].length, replacement });
    } else {
      ops.push({ start: line.start, end: line.start, replacement });
    }
  }
  return ops;
}

export function applyMarkdownTool(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  tool: MarkdownTool,
): MarkdownEdit {
  const start = clamp(selectionStart, 0, text.length);
  const end = clamp(Math.max(selectionStart, selectionEnd), start, text.length);

  let ops: Op[];
  switch (tool) {
    case "bold":
      ops = wrapOps(text, start, end, "**");
      break;
    case "italic":
      ops = wrapOps(text, start, end, "*");
      break;
    case "heading":
      ops = linePrefixOps(text, start, end, /^#{1,6}\s+/, "## ");
      break;
    case "bullet":
      ops = linePrefixOps(text, start, end, /^[-*+]\s+/, "- ");
      break;
    case "numbered":
      ops = numberedOps(text, start, end);
      break;
  }

  return {
    text: applyOps(text, ops),
    selectionStart: mapPos(start, ops, "start"),
    selectionEnd: mapPos(end, ops, "end"),
  };
}

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
