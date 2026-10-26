import type { ReactNode } from "react";
import { splitTrailingCitation, stripMarkdown, type MarkdownSection } from "@/lib/markdown";
import type { NoteTextScale } from "@/lib/types";

const INLINE_PATTERN =
  /\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[unclear\]/g;

type Inline = { text: string; kind?: "strong-em" | "strong" | "em" | "code" | "unclear" };

function parseInline(text: string): Inline[] {
  const parts: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index) });
    const [full, triple, bold, italic, code] = match;
    if (triple) parts.push({ text: triple, kind: "strong-em" });
    else if (bold) parts.push({ text: bold, kind: "strong" });
    else if (italic) parts.push({ text: italic, kind: "em" });
    else if (code) parts.push({ text: code, kind: "code" });
    else if (full === "[unclear]") parts.push({ text: full, kind: "unclear" });
    else parts.push({ text: full });
    last = index + full.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

function inlineNodes(text: string): ReactNode[] {
  const { text: body, citation } = splitTrailingCitation(text);
  const nodes: ReactNode[] = parseInline(body).map((part, index) => {
    if (!part.kind) return part.text;
    if (part.kind === "strong") return <strong key={index}>{part.text}</strong>;
    if (part.kind === "em") return <em key={index}>{part.text}</em>;
    if (part.kind === "strong-em")
      return (
        <strong key={index}>
          <em>{part.text}</em>
        </strong>
      );
    if (part.kind === "code")
      return (
        <code key={index} className="md-code">
          {part.text}
        </code>
      );
    return (
      <span key={index} className="md-unclear">
        {part.text}
      </span>
    );
  });
  if (citation) {
    nodes.push(
      <span key="citation" className="md-citation">
        {citation}
      </span>,
    );
  }
  return nodes;
}

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "bullet"; text: string }
  | { type: "numbered"; marker: string; text: string }
  | { type: "quote"; text: string }
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
    blocks.push({ type: "paragraph", line });
  }
  return blocks;
}

const SCALE_CLASS: Record<NoteTextScale, string> = {
  small: "md-scale-small",
  medium: "md-scale-medium",
  large: "md-scale-large",
};

export function Markdown({
  text,
  className = "",
  scale = "medium",
  renderers,
}: {
  text: string;
  className?: string;
  scale?: NoteTextScale;
  /** Optional trailing affordance per heading section (report a mistake, etc.). */
  renderers?: { afterHeading?: (heading: string | null, index: number) => ReactNode };
}) {
  const blocks = parseBlocks(String(text ?? ""));
  if (!blocks.length) {
    return <p className={`md-p ${SCALE_CLASS[scale]} ${className}`}>{stripMarkdown(text)}</p>;
  }

  // Precompute each block's heading ordinal so the render loop never mutates a
  // counter after render (React's compiler check flags that pattern).
  const headingIndexes = blocks.reduce<{ list: number[]; headings: number }>(
    (state, block) => {
      if (block.type !== "heading") {
        return { list: [...state.list, -1], headings: state.headings };
      }
      return { list: [...state.list, state.headings], headings: state.headings + 1 };
    },
    { list: [], headings: 0 },
  ).list;

  return (
    <div className={`md-body ${SCALE_CLASS[scale]} ${className}`}>
      {blocks.map((block, index) => {
        const gap = index === 0 ? "" : "md-gap";
        if (block.type === "heading") {
          const level = Math.min(4, Math.max(2, block.level + 1));
          const Tag = `h${level}` as "h2" | "h3" | "h4";
          const extra = renderers?.afterHeading?.(block.text, headingIndexes[index]);
          return (
            <Tag key={index} className={`${gap} md-heading md-heading-${block.level}`}>
              {inlineNodes(block.text)}
              {extra}
            </Tag>
          );
        }
        if (block.type === "quote") {
          return (
            <blockquote key={index} className={`${gap} md-quote`}>
              {inlineNodes(block.text)}
            </blockquote>
          );
        }
        if (block.type === "bullet") {
          return (
            <div key={index} className={`${gap} md-li`}>
              <span aria-hidden="true" className="md-bullet">
                •
              </span>
              <span>{inlineNodes(block.text)}</span>
            </div>
          );
        }
        if (block.type === "numbered") {
          return (
            <div key={index} className={`${gap} md-li`}>
              <span aria-hidden="true" className="md-marker">
                {block.marker}
              </span>
              <span>{inlineNodes(block.text)}</span>
            </div>
          );
        }
        return (
          <p key={index} className={`${gap} md-p`}>
            {inlineNodes(block.line)}
          </p>
        );
      })}
    </div>
  );
}

/** Read-only fallback for dense previews (course rows, chat source chips). */
export function MarkdownPreview({ text, lines = 2 }: { text: string; lines?: number }) {
  return (
    <p className="md-preview" style={{ WebkitLineClamp: lines }}>
      {stripMarkdown(text)}
    </p>
  );
}

export function Section({ section }: { section: MarkdownSection }) {
  return (
    <section className="md-section">
      {section.heading ? <h3 className="md-heading md-heading-2">{section.heading}</h3> : null}
      <Markdown text={section.body} />
    </section>
  );
}
