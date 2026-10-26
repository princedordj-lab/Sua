# Sua Web — Build Steps

> **Status (2026-10-26):** Milestones 0–6 shipped and verified (`npx tsc --noEmit`, `npx eslint .`, `npm run build`); Milestone 7 is code-complete but still needs live deploy + manual cross-platform QA.

**Tagline:** Hear it once. Know it for the exam.
**Scope:** A `web/` workspace built with **Next.js 16.4** (App Router, TypeScript, Tailwind CSS v4 — `create-next-app` resolved a major above the original Next 15 target), connected to the existing `backend/` Express API. Ships an **online-first MVP** on **Vercel**, feature-matched to the mobile P0 flows minus mobile-specific settings.

> **PRD deviation note.** The PRD lists "a web app or desktop app" as a V1 non-goal. This build direction was explicitly requested as a supplement to the mobile app — the web version targets the same V1 P0 features so students can study from a laptop in lecture halls and library sessions, sharing the user's NeonDB data, Clerk accounts and AI pipeline with the phone through the same backend. It does **not** replace the offline-first mobile commitments; the web MVP is online-first (section 2) and the offline gap is tracked as a deferral.

---

## 1. Stack and conventions

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | **Next.js 16.4, App Router, TypeScript** (target was 15; `create-next-app` installed 16) | Matches the repo's TS preference; server components keep client bundles small for low-data users. |
| Styling | **Tailwind CSS v4** + ported design tokens | `design_tokens/tailwind.config.js` + `tokens.js` port 1:1; NativeWind on mobile already speaks Tailwind classnames, so visual parity is cheap. |
| Auth | **`@clerk/nextjs`** (same Clerk instance as mobile) | One identity surface across platforms — a student's data is shared automatically because `ensureUser` keys users by Clerk id. |
| Data fetching | Direct browser calls to `EXPO_PUBLIC`-style `NEXT_PUBLIC_API_URL` with Clerk session tokens | Same Bearer pattern as mobile; avoids duplicating route logic in Next server actions. |
| Markdown | Port of `Sua/src/lib/markdown.ts` block-parser | The in-house renderer exists for React 19 compatibility; on web, the parser outputs React elements directly (no RN `<View>` tree, no third-party markdown lib). |
| Deployment | **Vercel** | Next.js-native, preview deploys per PR, easy env management. |
| State | React Context (mirror `AppContext` structure) + `useResource` client hooks | Lightest option with no new dependencies to validate; matches mobile's Context API architecture. |

### Folder

```text
web/
├── app/
│   ├── sign-in|sign-up/   # Clerk <SignIn/> / <SignUp/> (public)
│   ├── onboarding/        # first-run setup → first course
│   ├── app/               # protected product; URLs read /app/home, /app/note/[id], …
│   ├── layout.tsx         # ClerkProvider + appearance provider + fonts
│   ├── page.tsx           # marketing landing
│   ├── app.css            # app-screen styles
│   └── globals.css        # design tokens + marketing styles
├── components/            # app shell, data provider, UI primitives, markdown
├── lib/                   # api client, types, markdown, uploads, prefs, SRS
├── config/                # theme.ts (ports lightVars/darkVars) + appearance.tsx
├── proxy.ts               # Clerk middleware (Next 16 renamed middleware → proxy)
└── .env.local             # NEXT_PUBLIC_API_URL, Clerk keys
```

### Backend contract (consumed by web; defined in `backend/src/routes/`)

| Router | Endpoints | Web screens consuming them |
| --- | --- | --- |
| `me` | `GET /api/me`, `PATCH /api/me`, `POST /api/me/delete` | Profile, edit account, deletion. Push-token endpoints are mobile-only (n/a). |
| `courses` | `GET`/`POST`/`PATCH`/`DELETE /api/courses` | Courses tab, onboarding setup. |
| `notes` | `GET /api/notes/course/:courseId`, `POST /api/notes/sync`, `GET /api/notes/:noteId/study`, plus **web-added** `GET /api/notes/:noteId` | Note lists, viewer, study sets. Web uses `sync` upsert (push/pull) rather than offline queueing. |
| `uploads` | `POST /api/uploads/sign`, `POST /api/uploads/:id/complete`, `GET /api/assets/:id/url`, `DELETE /api/assets/:id` | Upload pipeline (sign → **direct `PUT` to the signed URL with progress** → complete). Cloudinary multipart remains only as the backend's compatibility fallback. |
| `jobs` | `POST /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/note/:noteId`, `POST /api/jobs/feedback` | Generation trigger, live status, Report-a-mistake. |
| `study` | `POST /api/study/sync/reviews`, `POST /api/study/sync/quiz-attempts`, `POST /api/study/attempts`, `GET /api/study/attempts/:id`, CRUD `/api/study/notes/:noteId/cards` + `/api/study/cards/:cardId`, plus **web-added reads** `GET /api/study/home-summary`, `GET /api/study/sets`, `GET /api/study/due?limit=&ahead=`, `GET /api/study/quizzes/:quizId` | Review session, deck editor, quizzes, Home/Study aggregates. |
| `chat` | `POST /api/chat/ask`, `GET /api/chat/messages`, `POST /api/chat/speech` | Ask Sua. `speech` accepts raw audio bodies (voice input, stretch). |

Allowed upload formats (`/sign` gates): documents `pdf,pptx,ppt,txt,docx`, images `jpg,jpeg,png,webp,heic,heif`, audio `m4a,mp3,wav,ogg,aac`, each ≤ 25 MB.

---

## 2. Architecture decisions (locked)

1. **Online-first MVP.** Every screen calls the API with loading / empty / error + retry states. No IndexedDB, no sync queue in v1-web. Offline support is a tracked deferral (question 1).
2. **Recording = stretch inside M3.** Typed notes and document/image uploads land first; the MediaRecorder pipeline is added at the end of M3 once uploads validate (question 2 — my choice, chosen because it de-risks format/QA while keeping the differentiator in scope).
3. **Next.js 15 App Router + TypeScript** (question 3) — **shipped on Next.js 16.4** because that is what `create-next-app` installed; the migration notes (proxy vs middleware, Cache Components/Suspense, `LayoutProps<>`) are captured in M1 and `web/README.md`.
4. **Vercel deploy** (question 4): production = main; preview = PR.
5. **Wi-Fi-only uploads and push-notification settings are mobile-only** and are dropped from the web preferences screen; note text size, appearance, remember-last-course port directly.
6. **No billing UI in web MVP.** Paystack (M5 mobile scope) stays untouched until validated; free-plan caps are surfaced read-only via usage data from `GET /api/me` and job 403s.

---

## 3. Milestones

Each milestone follows the repo convention: scope bullets, files, and an acceptance line ("done when…"). Tick checkboxes as work completes, mirroring `todo.md`/`milestone.md`.

### Milestone 0 — Scaffolding and design parity — ✅ Done (2026-10-23)

- [x] Scaffold Next.js 15 App Router project at `web/` (**note: create-next-app resolved to Next 16.4.2 with React 19.3 and Tailwind v4 / Turbopack — Next 16 breaks some older Next conventions; see `web/AGENTS.md` pointer to `node_modules/next/dist/docs/`**), add `web/` to root workspace docs conventions, and verify `npx tsc --noEmit` from `web/`.
- [x] Port design tokens into `web/app/globals.css` using Tailwind v4 CSS-first tokens (`@theme`): static accent palette (brand/gold/status/rating/course), radius/shadow/spacing/text-branded scales matching `Sua/src/config/theme.ts`, and the 6 scheme-reactive neutrals wired through `@theme inline` to CSS vars swapped by the `.dark` class (light `:root` defaults + warm-charcoal `.dark` values, same hexes as mobile).
- [x] Create `web/config/theme.ts` (port of mobile `colors`/`darkPalette`/`palette()`/`AppearanceScheme`) and `web/config/appearance.tsx` (`AppearanceProvider` + `useAppearance` + `usePalette`): `useSyncExternalStore`-backed (lint-clean under React 19 `set-state-in-effect` rule), reads persisted mode from `localStorage` key `appearance` (default `system`), follows `prefers-color-scheme` live, toggles `documentElement.classList(.dark)` + `data-theme` + `colorScheme`. Provider wraps children in `app/layout.tsx`.
- [x] `app/layout.tsx`: Plus Jakarta Sans via `next/font` (mobile's typeface), Sua metadata/title template, `bg-cream text-ink` body, `suppressHydrationWarning` for theme class.
- [x] Landing page `/` (tagline hero + health CTA) and `/health` page: client-fetches `GET /api/health`, shows status dot / API base / error detail + Retry; `NEXT_PUBLIC_API_URL` falls back to `http://localhost:4000/api`.
- [x] `web/.env.example` (documented, never real secrets) + `web/.env.local` dev defaults; `CORS_ORIGIN=*` already covers `http://localhost:3000` in dev (Vercel origin tightening deferred to M7).
- [x] Root `AGENTS.md` structure updated with `web/` entry.
- [x] Verified: `npx tsc --noEmit` clean, `npx eslint .` clean, `npm run build` green (3 static routes), live check — backend `GET /api/health` → `{"ok":true}`, CORS GET 200 + preflight 204 from `http://localhost:3000`, `/health` renders with token classes.

---

### Milestone 1 — Auth and app shell — ✅ Done (2026-10-26)

- [x] Install `@clerk/nextjs` 7.9 (`npm install @clerk/nextjs`); `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (and `CLERK_SECRET_KEY`) point at the same Clerk instance as mobile, so accounts and data are shared.
- [x] Add `proxy.ts` (**Next 16 renamed middleware → proxy**): `clerkMiddleware()` + `createRouteMatcher`, public `/`, `/health`, `/sign-in(.*)`, `/sign-up(.*)`; every other route protected.
- [x] Auth routes `app/sign-in/[[...sign-in]]` + `app/sign-up/[[...sign-up]]`: Clerk `<SignIn/>`/`<SignUp/>` inside `<Suspense>` (Cache Components requires the boundary), with Google + email/password exactly as configured for mobile.
- [x] App shell `app/app/layout.tsx` + `components/app-shell.tsx`: authenticated wrapper, theme + data providers, desktop sidebar / mobile bottom nav (Home, Courses, Create, Study, Ask Sua, Profile). **Routes live under `app/app/…` so URLs read `/app/home`** instead of a `(app)` group. `usePathname()` readers are Suspense-wrapped so dynamic-param routes prerender.
- [x] API client `lib/api.ts`: typed `fetch` wrapper over `NEXT_PUBLIC_API_URL`, browser Clerk token via `useApi()` (`useAuth().getToken()`), typed `ApiError` matching the backend `{ error }` shape, and a `useResource` hook for fetch-on-mount + retry.
- [x] Port `Sua/src/lib/types.ts` → `lib/types.ts` (course, note, card, quiz, asset, job, chat, scheduling fields + the additive `Server*` response shapes).
- [x] Onboarding parity `/onboarding`: university, programme, level, optional exam date; posts the first course via `POST /api/courses` and lands on `/app/home`.
- [x] Sign-out in the sidebar/profile menu; `GET /api/me` provisions a row for a fresh Clerk user through the backend's `ensureUser`.

**Files:** `web/proxy.ts`, `web/app/sign-in|sign-up/…`, `web/app/onboarding/page.tsx`, `web/app/app/{layout.tsx,home/page.tsx}`, `web/components/{app-shell.tsx,app-data.tsx}`, `web/lib/{api.ts,use-api.ts,use-resource.ts,types.ts}`.

**Verified:** `npx tsc --noEmit`, `npx eslint .` and `npm run build` are clean; a signed-out visit to `/app/home` redirects to `/sign-in`.

---

### Milestone 2 — Courses and notes (CRUD) — ✅ Done (2026-10-26)

- [x] Courses tab `/app/courses`: list from `GET /api/courses` with name, code, exam countdown chip, colour dot (token classes from `lib/course-style.ts`), active/archived filter, search, empty state.
- [x] Course create/rename/archive/delete modals mapping to `POST/PATCH/DELETE /api/courses`, including delete confirmation, an opt-in "delete its notes too" switch, and "move notes elsewhere" via PATCH.
- [x] Course detail `/app/courses/[id]`: notes from `GET /api/notes/course/:courseId` grouped into typed notes / uploads / references, per-note AI status chip, note count on the course card, and study sets from `GET /api/study/sets`.
- [x] Note viewer `/app/note/[id]`: title, course pill, source + date meta, body through the in-house markdown renderer, transcript disclosure for captured notes, note/summary/cards/quiz tabs, and a study-set panel (cards + quizzes) reading the note payload.
- [x] Typed editor `/app/create?mode=type`: 2s-debounce autosave to `POST /api/notes/sync` (with `updatedAt` guard), markdown toolbar ported from `Sua/src/lib/markdown.ts`, word count, save-state chip, reference-sheet toggle.
- [x] Cross-page parity: notes move between courses from the course screen and the note menu (`PATCH /api/notes/:noteId`), and notes can be deleted with confirmation.
- [x] Error states: every page has loading skeletons, retry buttons (`ErrorState`) and empty states; API failures never blank the screen.

**Files:** `web/app/app/courses/{page.tsx,[id]/page.tsx}`, `web/app/app/note/[id]/page.tsx`, `web/app/app/create/create-client.tsx`, `web/components/{markdown.tsx,ui.tsx}`, `web/lib/{markdown.ts,use-api.ts}`.

**Verified:** `npx tsc --noEmit`, `npx eslint .`, `npm run build` clean; create → open → edit → move → delete exercised against the local API.

---

### Milestone 3 — Capture: uploads and recording — ✅ Done (2026-10-26)

- [x] Upload flow: browser `<input type=file>` with the same accept lists as the backend `/sign` allowlist → create the note through `POST /api/notes/sync` → `POST /api/uploads/sign` (`storageProvider: "neon"`, `task: lecture_note | course_reference`) → **direct `PUT` to the short-lived Neon Object Storage URL with `XMLHttpRequest` progress** → `POST /api/uploads/:id/complete` → job status page → note. (**Cloudinary multipart is only the backend's compatibility fallback**; the web never sees its secrets.)
- [x] Document-to-note pipeline: sign with `task: lecture_note` for PDF/DOCX/PPTX/TXT/images so text extraction, summary, flashcards and quiz run server-side after `/complete`; "course reference" signs with `course_reference` and returns a reference sheet with no cards.
- [x] Enforce 25 MB client-side (and 100k-char extraction cap server-side) with a clear rejection message before any upload starts.
- [x] Create tab `/app/create` with three modes (Type, Upload, Record) as a segmented control plus the mobile-style mode cards and tips.
- [x] Recording: `getUserMedia` + `MediaRecorder` → decode with `AudioContext` → **mono 16 kHz PCM WAV** (falls back to raw Opus/Ogg where the browser cannot convert), pause/resume, visible timer and 12-minute cap (≈25 MB) with a warning before the limit; on stop the take joins the same upload → complete → `POST /api/jobs` flow.
- [x] Voice note defaults: the recorded note is created first, then `POST /api/jobs` with `kind: lecture_note`; if the browser cannot transcribe/convert the format the take is kept and the note shows the pipeline's own state, which the student can re-trigger.

**Files:** `web/app/app/create/{page.tsx,create-client.tsx}` (includes the `toWav` encoder), `web/lib/uploads.ts` (validate → sign → PUT → complete), `web/app/app/jobs/[noteId]/page.tsx`.

**Verified:** `npx tsc --noEmit` / `npx eslint .` / `npm run build` clean; upload path exercised through sign → PUT → complete against the local API (AI stages still need the worker + Redis).

---

### Milestone 4 — AI pipeline visibility and Ask Sua — ✅ Done (2026-10-26)

- [x] Job status UI `/app/jobs/[noteId]`: stage list driven by the note's `aiState` (queued → reading → reading scans → digesting → writing → checking → summarising → making cards → ready) with a progress bar, live polling while active, elapsed-time copy, and failure state showing the error with a "Try again" button that re-posts `POST /api/jobs` (backend dedupes active jobs).
- [x] Note detail integrated: summary body renders from the note record once the job completes, with the "Sua is working" card, reference-sheet banner and study-set panel in the same screen.
- [x] Report-a-mistake: `ReportMistake` modal + `ReportButton` on the summary, every flashcard answer and every quiz question, posting to `POST /api/jobs/feedback` with the source text (mobile parity).
- [x] Ask Sua `/app/ask-sua`: course picker, chat thread from `GET /api/chat/messages` (history restored), `POST /api/chat/ask`, source-note chips linking to the viewer, "Explain simply / Give an example / Quiz me on this" quick actions, typing indicator, and the general-knowledge fallback note.
- [x] Free-plan meter: `usage` from `GET /api/me` shown on Home, Ask Sua and Profile; the composer surfaces the backend 403 as an upgrade notice instead of silently failing (read-only, no billing UI).
- [x] Markdown answers render through the same in-house renderer as notes.

**Files:** `web/app/app/jobs/[noteId]/page.tsx`, `web/app/app/ask-sua/page.tsx`, `web/app/app/note/[id]/page.tsx`, `web/components/{report-mistake.tsx,markdown.tsx}`, `web/lib/generation.ts` (stage labels shared with create/note/jobs).

**Verified:** typecheck/lint/build clean. **Live stage transitions need the BullMQ worker + Redis + `XKIRO_API_KEY`** (see `backend/README`/AGENTS) — without them a job stays `queued`, which the UI shows as a queued stage rather than an error.

---

### Milestone 5 — Study: daily review, decks, quizzes — ✅ Done (2026-10-26)

- [x] Home "Daily Review" card: due count, streak, 7-day activity and per-course progress from **new additive backend reads** `GET /api/study/home-summary`, `GET /api/study/sets` and `GET /api/study/due` (mobile computes the same numbers locally from SQLite; the web needs a server aggregate, so these routes were added without touching RLS or `withUser` conventions).
- [x] Review session `/app/review`: question/answer turn, Again / Hard / Good / Easy grading with the SRS constants byte-identical to `Sua/src/lib/srs.ts` and `backend/src/lib/srs.js` (ease 2.5, floor 1.3, Again 10 min, Good 1d/6d/×ease, Easy 4d/×ease×1.3); each grade POSTs to `/api/study/sync/reviews` immediately and the server's schedule is authoritative. Session length from preferences caps the queue; keyboard shortcuts (space, 1–4) work. **Review-ahead parity:** `GET /api/study/due?ahead=7` also returns `aheadCards`, so when nothing is due the web offers the same short look-ahead session as mobile instead of a dead end, with a "Reviewing ahead" chip and mobile-matching completion copy ("Review complete", "{strong} of {graded} kept fresh", "N cards return shortly").
- [x] Deck view `/app/deck/[id]`: card list with due hints and state, add card (`POST /api/study/notes/:noteId/cards`), edit (`PATCH /api/study/cards/:cardId`), delete (`DELETE /api/study/cards/:cardId`), quiz tiles linking to `/app/quiz/[id]`.
- [x] Quiz view `/app/quiz/[id]`: MCQ / true-false instant grade with explanation reveal; short answers POST to `/api/study/attempts` then poll `GET /api/study/attempts/:id` until AI marking finishes (with a marking screen, failure copy and re-submit); results screen with score, per-question verdicts, missed answers and "make cards from mistakes" (bulk cards POST). `GET /api/study/quizzes/:quizId` was added so a deep link resolves the quiz with note/course context.
- [x] Notes viewer cards deep-link into deck/quiz tiles from the study panel.

**Files:** `web/app/app/{study,review,deck/[id],quiz/[id]}/…`, `web/lib/srs.ts`, `web/lib/types.ts` (`ServerDueResponse`), `backend/src/routes/study.js` (`home-summary`, `sets`, `due` + `ahead`, `quizzes/:quizId`).

**Verified:** `npx tsc --noEmit`, `npx eslint .`, `npm run build` clean; backend `npx esbuild src/routes/study.js --format=esm` parses. Live review/quiz marking still needs the worker.

---

### Milestone 6 — Profile, preferences and appearance — ✅ Done (2026-10-26)

- [x] Profile hub `/app/profile`: account info (`GET /api/me`, editable display name via `PATCH /api/me`), Clerk-managed avatar, plan chip (Free; Pro renders when plan data exists — no billing CTA), usage meters for summaries / assistant questions / references, courses + notes counts, links into preferences, Clerk account portal and Ask Sua.
- [x] Preferences screen `/app/preferences`, mirroring mobile minus mobile-only rows:
  - Appearance: System / Light / Dark → toggles `.dark` + `data-theme` + `color-scheme`, pre-paint script avoids a flash, OS preference is the default (`prefers-color-scheme`).
  - Review session length (10/20/30 presets + 5–50 slider; server clamps too).
  - Note text size (small/medium/large → 14/16/20) applied to the note reader and summaries, with a live preview.
  - Remember-last-capture-course: persisted in `localStorage` (`sua.prefs`) and used to default the Create form. (No SQLite on web — KV is client-side.)
- [x] AI settings from PRD §6.10 where free: summary length (short/standard/detailed) and language (English) rendered and persisted; the copy states plainly that the pipeline still writes standard depth until the prompt ships, so nothing is silently ignored.
- [x] Data controls: "Clear offline storage" replaced with an account-data summary; account + data deletion stays in the Clerk portal / backend `POST /api/me/delete` path behind a typed confirmation on the profile danger card.
- [x] Security: link to the Clerk account portal (same instance as mobile) and a sign-out action in the shell.
- [x] Accessibility pass: `aria-label`s on icon buttons, `aria-current` on nav, visible focus rings, 48 px tap targets, reduced-motion block for card flips, pulses and typing dots, and `--rating-*` colors that keep grade buttons readable in both schemes.

**Files:** `web/app/app/profile/page.tsx`, `web/app/app/preferences/page.tsx`, `web/lib/prefs.ts`, `web/config/appearance.tsx`, `web/app/app.css`.

**Verified:** typecheck/lint/build clean; dark mode and text size exercised in the browser. No hard-coded hexes remain outside `config/theme.ts` and the token definitions.

---

### Milestone 7 — Verification, hardening, and Vercel deploy — 🟡 Code done, deploy/manual QA pending

- [ ] Cross-platform data parity checklist (manual QA): a shared Clerk user edits note → posts course → takes quiz → deletes flashcard on web → confirm each view on mobile; reverse direction too. **Not run yet** — needs a real Clerk user + Neon DB + a mobile build side by side.
- [ ] Lighthouse/Next audit: <100 KB JS per route where possible; images OK without `next/image` for user content; loading skeletons on every screen; tone/wording typo sweep against the PRD voice ("Sua", "study set", "likely exam questions"). **Skeletons/empty states and the wording sweep are done; Lighthouse has not been measured** (needs a deployed URL or `next start` + Chrome).
- [ ] Privacy/observability: no Cloudinary secrets ever in browser code (verify bundle grep); no student content in client errors (PostHog-style client digest only, matching backend policy); web console errors tracked through Vercel logs. **Verified by source grep — the web only ever names `storageProvider` literals, never keys — but Vercel log wiring is a deploy-time step.**
- [ ] Accessibility + performance checkoff: tab order, screen reader labels, keyboard-only flow sign-in → review a card → submit quiz. **Keyboard review (space, 1–4), aria labels, focus rings and reduced motion are implemented; the full sign-in → quiz keyboard walkthrough still needs doing in a browser.**
- [ ] Deployment: `vercel link` `web/`; env vars `NEXT_PUBLIC_API_URL`, Clerk publishable/secret; backend `CORS_ORIGIN` + trusted Clerk Sign-in-URL per deployed domain; Vercel preview on PRs.
- [x] Write `web/README.md` (structure, run instructions, deployment notes) and a short section inside the root `README.md` or `AGENTS.md`.
- [x] Mark `web/` ship status inside `todo.md` with a "Milestone ∙ Web MVP" block linking back to buildstep.md and recording the deferral notes below.

**Done when:** Production Vercel URL signs in real Clerk users, passes the parity checklist, scores >90 Lighthouse accessibility + performance on Home, and no build/runtime warnings run on deploy.

---

## 4. Deferral notes (explicitly out of web MVP)

- **Offline mode.** The web app is online-first by decision — offline note viewing, offline review, and an IndexedDB sync queue are re-approached after the mobile-style sync layer is validated. Question 1's answer defers PRD §8 "Offline" NFRs to a web-followup, documented here.
- **Wi-Fi-only uploads, push notifications.** Mobile-only by nature; the web analogue would be service-worker/badge APIs (not in scope).
- **Billing (Paystack in GHS).** Follows mobile pricing validation; no Paystack UI on web until mobile billing lands.
- **Exam Mode + Past Questions + Study Circles (V1.5).** Web parity milestones will be appended to this doc after V1-web ships.
- **Course-reference jobs (`course_reference`).** Enqueued from mobile courses today; web read-side lands with V1.5 parity work.

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| MediaRecorder output codec mismatches `/sign` audio allowlist | Cap encode to `wav`/`ogg` output; verify format string client-side before signing; QA on Chrome + Safari. |
| Clerk token expiry breaks long-running job polling | Refresh token per polling tick via `useSession().getToken()`; on 401, surface a re-login state instead of silent failure. |
| Streak/weekly-summary data is mobile-locally-computed today | Add `GET /api/study/home-summary` backend aggregate in M5 (small, additive); do not duplicate the computation client-side. |
| Backend caps (Free plan) seen as blocking by web users while mobile keeps offline-queued generation | Web still disallows queueing — show a soft banner: "Will run on next visit" when a cap hit is reported; no second client-side queue. |
| PRD non-goal conflict (web app was a V1 non-goal) | Scope is user-directed; keep the deviation note at the top so marketing/launch docs stay consistent. |

---

*buildstep.md v1.0 · October 2026 · Web MVP (online-first) build sequence for `web/`*
