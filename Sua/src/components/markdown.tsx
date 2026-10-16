import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { stripMarkdown } from "../lib/markdown";

// Minimal markdown renderer for note bodies and extracted source text.
// Deliberately a small in-house parser: it covers the subset the toolbar and
// the AI pipeline produce (headings, bullet/numbered lists, bold, italic,
// inline code) without pulling a third-party renderer into the bundle.

type Inline = { text: string; className?: string };

const INLINE_PATTERN = /\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;

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
    else if (code) parts.push({ text: code, className: "font-sans-medium text-brand" });
    else parts.push({ text: full });
    last = index + full.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

function inlineNodes(text: string): ReactNode[] {
  return parseInline(text).map((part, index) =>
    part.className ? (
      <Text key={index} className={part.className}>
        {part.text}
      </Text>
    ) : (
      part.text
    ),
  );
}

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "bullet"; text: string }
  | { type: "numbered"; marker: string; text: string }
  | { type: "paragraph"; line: string };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
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
    blocks.push({ type: "paragraph", line });
  }
  return blocks;
}

function headingClass(level: number) {
  if (level <= 1) return "text-title font-sans-extrabold text-ink";
  if (level === 2) return "text-h3 font-sans-extrabold text-ink";
  return "text-body-lg font-sans-bold text-ink";
}

export function Markdown({
  text,
  className,
  numberOfLines,
}: {
  text: string;
  className?: string;
  numberOfLines?: number;
}) {
  if (numberOfLines !== undefined) {
    return (
      <Text numberOfLines={numberOfLines} className={className ?? "text-body leading-7 text-ink"}>
        {stripMarkdown(text)}
      </Text>
    );
  }

  const blocks = parseBlocks(text);
  if (!blocks.length) {
    return (
      <Text className={className ?? "text-body leading-7 text-ink"}>{stripMarkdown(text)}</Text>
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
        if (block.type === "bullet") {
          return (
            <View key={index} className={`${gap}flex-row gap-2`}>
              <Text className="text-body leading-7 text-ink">•</Text>
              <Text className="flex-1 text-body leading-7 text-ink">{inlineNodes(block.text)}</Text>
            </View>
          );
        }
        if (block.type === "numbered") {
          return (
            <View key={index} className={`${gap}flex-row gap-2`}>
              <Text className="text-body font-sans-bold leading-7 text-ink">{block.marker}</Text>
              <Text className="flex-1 text-body leading-7 text-ink">{inlineNodes(block.text)}</Text>
            </View>
          );
        }
        return (
          <Text key={index} className={`${gap}text-body leading-7 text-ink`}>
            {inlineNodes(block.line)}
          </Text>
        );
      })}
    </View>
  );
}
