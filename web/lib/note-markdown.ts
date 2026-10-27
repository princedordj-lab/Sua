// Markdown <-> Lexical conversion for the web note editor.
//
// The note body stays markdown: mobile renders it with its own parser, the AI
// pipeline rewrites it, and `web/components/markdown.tsx` displays it. The rich
// editor is only a view over that string, so both directions are restricted to
// the subset every reader understands (`## `, `### `, bullets, numbered lists,
// quotes, bold, italic and inline code).

import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  BOLD_ITALIC_STAR,
  BOLD_STAR,
  HEADING,
  INLINE_CODE,
  ITALIC_STAR,
  ORDERED_LIST,
  QUOTE,
  UNORDERED_LIST,
  type Transformer,
} from "@lexical/markdown";

/**
 * Element transformers first, inline ones last — Lexical matches them in order.
 * Anything outside this list (tables, links, fenced code, `---`) has no
 * transformer, so it survives as literal text instead of being dropped.
 */
export const NOTE_TRANSFORMERS: Transformer[] = [
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  BOLD_STAR,
  ITALIC_STAR,
  BOLD_ITALIC_STAR,
  INLINE_CODE,
];

/**
 * Lexical escapes markdown-significant characters in plain text (`x * y`
 * becomes `x \* y`). Neither our reader nor the mobile parser understands
 * backslash escapes, so they would surface as literal backslashes inside a
 * formula. Undo exactly those escapes on the way out.
 */
const ESCAPED_LITERAL = /\\([*_`~\\])/g;

export function markdownToLexical(markdown: string): void {
  $convertFromMarkdownString(markdown, NOTE_TRANSFORMERS);
}

export function lexicalToMarkdown(): string {
  return $convertToMarkdownString(NOTE_TRANSFORMERS)
    .replace(ESCAPED_LITERAL, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
