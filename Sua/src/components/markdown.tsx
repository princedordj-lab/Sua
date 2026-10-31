import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { stripMarkdown } from "../lib/markdown";

// Minimal markdown renderer for note bodies and extracted source text.
// Deliberately a small in-house parser: it covers the subset the toolbar and
// the AI pipeline produce (headings, bullet/numbered lists, bold, italic,
// inline code, simple pipe tables) without pulling a third-party renderer into
// the bundle.

type Inline = { text: string; className?: string };

const INLINE_PATTERN =
  /\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[unclear\]/g;

function parseInline(text: string): Inline[] {
  const parts: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index) });
    const [full, triple, bold, italic, code] = match;
    if (triple) parts.push({ text: triple, className: "font-sans-bold italic" });
    else if (bold) parts.push({ text: bold, className: "font-sans-bold" });
    else if (italic) parts.push({ text: italic, className: "italic" });
    else if (code)
      parts.push({ text: code, className: "rounded bg-brand/10 px-1 font-sans-medium text-brand" });
    else if (full === "[unclear]") parts.push({ text: full, className: "italic text-ink-faint" });
    else parts.push({ text: full });
    last = index + full.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

function inlineNodes(text: string): ReactNode[] {
  // Trailing source citations are reference material, not prose: render them
  // smaller and muted so they never interrupt reading a sentence.
  const citation = text.match(TRAILING_CITATION);
  const body = citation ? text.slice(0, citation.index) : text;
  const nodes: ReactNode[] = parseInline(body).map((part, index) =>
    part.className ? (
      <Text key={index} className={part.className}>
        {part.text}
      </Text>
    ) : (
      part.text
    ),
  );
  if (citation) {
    nodes.push(
      <Text key="citation" className="text-caption text-ink-faint">
        {` ${citation[1]}`}
      </Text>,
    );
  }
  return nodes;
}

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "bullet"; text: string }
  | { type: "numbered"; marker: string; text: string }
  | { type: "quote"; text: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "paragraph"; line: string };

// A source citation closing a paragraph: (Slide 4-6), (p. 12), (about 12:30).
const TRAILING_CITATION = /\s*(\((?:slides?|pp?\.|pages?|about)\s*[^)]*\))\s*$/i;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      blocks.push({ type: "quote", text: quote[1] });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push({ type: "bullet", text: bullet[1] });
      continue;
    }
    const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (numbered) {
      blocks.push({ type: "numbered", marker: `${numbered[1]}.`, text: numbered[2] });
      continue;
    }
    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1])) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push({ type: "table", header, rows });
      continue;
    }
    blocks.push({ type: "paragraph", line });
  }
  return blocks;
}

export type MarkdownScale = "small" | "medium" | "large";

// Reader text scale. Medium keeps the shipped sizes; the tiers adjust the
// body run (the size notes and AI copy are read at). Headings stay fixed.
const BODY_CLASS: Record<MarkdownScale, { base: string; bold: string }> = {
  small: { base: "text-small leading-6", bold: "text-small font-sans-bold leading-6" },
  medium: { base: "text-body leading-7", bold: "text-body font-sans-bold leading-7" },
  large: { base: "text-body-lg leading-8", bold: "text-body-lg font-sans-bold leading-8" },
};

function headingClass(level: number) {
  if (level <= 1) return "text-title font-sans-extrabold text-ink";
  if (level === 2) return "text-h3 font-sans-extrabold text-ink";
  return "text-body-lg font-sans-bold text-ink";
}

export function Markdown({
  text,
  className,
  numberOfLines,
  scale = "default",
}: {
  text: string;
  className?: string;
  numberOfLines?: number;
  scale?: MarkdownScale | "default";
}) {
  // "default" keeps today's classes exactly when no preference applies
  // (dense previews, summaries inline, etc.). Only the note reader passes a
  // preference scale.
  const body = scale === "default" ? "text-body leading-7" : BODY_CLASS[scale].base;
  const bodyBold =
    scale === "default" ? "text-body font-sans-bold leading-7" : BODY_CLASS[scale].bold;

  if (numberOfLines !== undefined) {
    return (
      <Text numberOfLines={numberOfLines} className={className ?? `${body} text-ink`}>
        {stripMarkdown(text)}
      </Text>
    );
  }

  const blocks = parseBlocks(text);
  if (!blocks.length) {
    return (
      <Text className={className ?? `${body} text-ink`}>{stripMarkdown(text)}</Text>
    );
  }

  return (
    <View className={className}>
      {blocks.map((block, index) => {
        const gap = index === 0 ? "" : "mt-3 ";
        if (block.type === "heading") {
          return (
            <Text key={index} className={`${gap}${headingClass(block.level)}`}>
              {inlineNodes(block.text)}
            </Text>
          );
        }
        if (block.type === "quote") {
          return (
            <View key={index} className={`${gap}border-l-2 border-line pl-3`}>
              <Text className={`${body} text-ink-soft`}>{inlineNodes(block.text)}</Text>
            </View>
          );
        }
        if (block.type === "bullet") {
          return (
            <View key={index} className={`${gap}flex-row gap-2`}>
              <Text className={`${body} text-ink`}>•</Text>
              <Text className={`flex-1 ${body} text-ink`}>{inlineNodes(block.text)}</Text>
            </View>
          );
        }
        if (block.type === "numbered") {
          return (
            <View key={index} className={`${gap}flex-row gap-2`}>
              <Text className={`${bodyBold} text-ink`}>{block.marker}</Text>
              <Text className={`flex-1 ${body} text-ink`}>{inlineNodes(block.text)}</Text>
            </View>
          );
        }
        if (block.type === "table") {
          return (
            <ScrollView
              key={index}
              horizontal
              showsHorizontalScrollIndicator={false}
              className={gap}
            >
              <View className="min-w-[240px] overflow-hidden rounded-card border border-line">
                <View className="flex-row bg-cream">
                  {block.header.map((cell, column) => (
                    <View
                      key={column}
                      className="min-w-28 flex-1 border-r border-line px-3 py-2 last:border-r-0"
                    >
                      <Text className={`${bodyBold} text-ink`}>{inlineNodes(cell)}</Text>
                    </View>
                  ))}
                </View>
                {block.rows.map((row, rowIndex) => (
                  <View key={rowIndex} className="flex-row border-t border-line">
                    {Array.from(
                      { length: Math.max(block.header.length, row.length) },
                      (_, column) => (
                        <View
                          key={column}
                          className="min-w-28 flex-1 border-r border-line px-3 py-2 last:border-r-0"
                        >
                          <Text className={`${body} text-ink`}>
                            {inlineNodes(row[column] ?? "")}
                          </Text>
                        </View>
                      ),
                    )}
                  </View>
                ))}
              </View>
            </ScrollView>
          );
        }
        return (
          <Text key={index} className={`${gap}${body} text-ink`}>
            {inlineNodes(block.line)}
          </Text>
        );
      })}
    </View>
  );
}
