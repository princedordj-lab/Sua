<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Web project conventions

- The web app is Next.js 16.4 / React 19 with Tailwind v4. Shared design tokens live in `app/globals.css`; product and route styles live in `app/app.css`, and legal-page styles live in `app/legal.css`.
- Keep all routes usable without horizontal page scrolling on phone widths. When changing a page, inspect its route and shared-shell styles; check public pages, auth/onboarding, and signed-in routes rather than assuming a shared fix covers every surface.
- The typed-note editor is a Lexical rich-text surface (`components/rich-editor.tsx`) that reads and writes markdown through `lib/note-markdown.ts`. The body stays markdown because mobile and the AI pipeline parse it — extend the transformer subset instead of reintroducing a raw `<textarea>`.
- Do not hide layout bugs with `overflow-x: hidden` or `overflow-x: clip` on `html` or `body`. Fix the cause: add `min-width: 0` to shrinkable grid/flex children, use `minmax(0, 1fr)` for shrinkable grid tracks, let action rows wrap or stack at narrow breakpoints, and wrap or truncate long content intentionally.
- Keep clipping scoped to the component that owns decorative or contained content (for example, the course hero card clipping its accent stripe to its rounded edge). Do not use global clipping to compensate for an oversized child.
- Preserve the mobile app shell: the desktop sidebar is replaced by the five-item equal-width bottom navigation at narrow widths. Keep nav items shrinkable, labels on one line, minimum 48px targets, safe-area bottom padding, and hide the bar while the keyboard is open using the shared visual-viewport hook.
- Use the existing CSS variables and theme tokens; keep spacing and breakpoints consistent with neighboring components. Decorative artwork must scale or stay within its owning container instead of forcing the document wider.
- For layout changes, audit the rendered DOM at 320px, 375px, and 430px when practical. Check both `document.documentElement.scrollWidth` versus `clientWidth` and individual element bounding boxes whose right edge exceeds `clientWidth`; inspect every public and signed-in route affected. Do not report a route as verified from CSS inspection alone.
- For app shell or navigation changes, also verify keyboard-open behavior and safe-area spacing. Keep the Next.js dev indicator dev-only and do not reserve or rely on its screen area in product layouts.

## Web verification

From `web/`, run `npx tsc --noEmit`, `npx eslint .`, and `npm run build`. For responsive UI changes, supplement these checks with a browser viewport audit; see the width-audit rules above.

<!-- BEGIN:nextjs-agent-feedback -->

## Report Next.js feedback

The project owner enabled `experimental.agentFeedback`, authorizing this feedback pass. When enabled, `next dev` writes this block and restores it if removed. Commit `AGENTS.md` with your work to keep the tree clean.

During the current user request, retain anonymized facts as feedback candidates for meaningful or recurring Next.js issues:

- Crashes, hangs, OOMs, or unexpected slowness
- Incorrect behavior, output, errors, or diagnostics
- Missing, unclear, or conflicting documentation
- Unexpected CLI, codemod, Skill, or upgrade behavior and non-obvious workarounds

Continue the current user request without reporting immediately. Routine debugging is not feedback. Verify changes before retaining them as feedback candidates. Never retain code, logs, paths, URLs, secrets, personal information, or project-specific data.

Retain qualifying friction even if it is later fixed or worked around; record the final outcome during the reporting pass.

Before the final response, run one reporting pass. If candidates remain, from this file's directory run `npx --no-install next internal agent-feedback-instructions` once without piping or truncating its output. Follow its output or error guidance. If a network sandbox blocks it, retry with network access; if it still returns no output, continue normally.

<!-- END:nextjs-agent-feedback -->
