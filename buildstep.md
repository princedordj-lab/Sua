# Sua Web — Build Steps

**Tagline:** Hear it once. Know it for the exam.
**Scope:** A `web/` workspace built with Next.js 15 (App Router, TypeScript, Tailwind CSS), connected to the existing `backend/` Express API. Ships an **online-first MVP** on **Vercel**, feature-matched to the mobile P0 flows minus mobile-specific settings.

> **PRD deviation note.** The PRD lists "a web app or desktop app" as a V1 non-goal. This build direction was explicitly requested as a supplement to the mobile app — the web version targets the same V1 P0 features so students can study from a laptop in lecture halls and library sessions, sharing the user's NeonDB data, Clerk accounts and AI pipeline with the phone through the same backend. It does **not** replace the offline-first mobile commitments; the web MVP is online-first (section 2) and the offline gap is tracked as a deferral.

---

## 1. Stack and conventions

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | **Next.js 15, App Router, TypeScript** | Matches the repo's TS preference; server components keep client bundles small for low-data users. |
| Styling | **Tailwind CSS v4** + ported design tokens | `design_tokens/tailwind.config.js` + `tokens.js` port 1:1; NativeWind on mobile already speaks Tailwind classnames, so visual parity is cheap. |
| Auth | **`@clerk/nextjs`** (same Clerk instance as mobile) | One identity surface across platforms — a student's data is shared automatically because `ensureUser` keys users by Clerk id. |
| Data fetching | Direct browser calls to `EXPO_PUBLIC`-style `NEXT_PUBLIC_API_URL` with Clerk session tokens | Same Bearer pattern as mobile; avoids duplicating route logic in Next server actions. |
| Markdown | Port of `Sua/src/lib/markdown.ts` block-parser | The in-house renderer exists for React 19 compatibility; on web, the parser outputs React elements directly (no RN `<View>` tree, no third-party markdown lib). |
| Deployment | **Vercel** | Next.js-native, preview deploys per PR, easy env management. |
| State | React Context (mirror `AppContext` structure) + SWR-style `use client` hooks | Lightest option with no new dependencies to validate; matches mobile's Context API architecture. |

### Folder

```text
web/
├── app/
│   ├── (auth)/            # sign-in, sign-up, onboarding (Clerk public)
│   ├── (app)/             # protected shell: home, courses, create, study, profile tabs
│   ├── layout.tsx         # ClerkProvider + theme provider + fonts
│   └── page.tsx           # marketing/redirect to sign-in
├── components/            # shared UI (md renderer, cards, empty states)
├── lib/                   # api client, types, markdown, uploads, palette
├── config/                # theme.ts (ports lightVars/darkVars)
└── .env.local             # NEXT_PUBLIC_API_URL, Clerk keys
```

### Backend contract (consumed by web; defined in `backend/src/routes/`)

| Router | Endpoints | Web screens consuming them |
| --- | --- | --- |
| `me` | `GET /api/me`, `PATCH /api/me`, `POST /api/me/delete` | Profile, edit account, deletion. Push-token endpoints are mobile-only (n/a). |
| `courses` | `GET`/`POST`/`PATCH`/`DELETE /api/courses` | Courses tab, onboarding setup. |
| `notes` | `GET /api/notes/course/:courseId`, `POST /api/notes/sync`, `GET /api/notes/:noteId/study` | Note lists, viewer, study sets. Web uses `sync` upsert (push/pull) rather than offline queueing. |
| `uploads` | `POST /api/uploads/sign`, `POST /api/uploads/:id/complete`, `GET /api/assets/:id/url`, `DELETE /api/assets/:id` | Upload pipeline (sign → Cloudinary multipart → complete). |
| `jobs` | `POST /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/note/:noteId`, `POST /api/jobs/feedback` | Generation trigger, live status, Report-a-mistake. |
| `study` | `POST /api/study/sync/reviews`, `POST /api/study/sync/quiz-attempts`, `POST /api/study/attempts`, `GET /api/study/attempts/:id`, CRUD `/api/study/notes/:noteId/cards` + `/api/study/cards/:cardId` | Review session, deck editor, quizzes. |
| `chat` | `POST /api/chat/ask`, `GET /api/chat/messages`, `POST /api/chat/speech` | Ask Sua. `speech` accepts raw audio bodies (voice input, stretch). |

Allowed upload formats (`/sign` gates): documents `pdf,pptx,ppt,txt,docx`, images `jpg,jpeg,png,webp,heic,heif`, audio `m4a,mp3,wav,ogg,aac`, each ≤ 25 MB.

---

## 2. Architecture decisions (locked)

1. **Online-first MVP.** Every screen calls the API with loading / empty / error + retry states. No IndexedDB, no sync queue in v1-web. Offline support is a tracked deferral (question 1).
2. **Recording = stretch inside M3.** Typed notes and document/image uploads land first; the MediaRecorder pipeline is added at the end of M3 once uploads validate (question 2 — my choice, chosen because it de-risks format/QA while keeping the differentiator in scope).
3. **Next.js 15 App Router + TypeScript** (question 3).
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

### Milestone 1 — Auth and app shell

- [ ] Install `@clerk/nextjs`; configure `CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY` (dev keys from the existing Clerk app so the same users work).
- [ ] Add `middleware.ts`: `clerkMiddleware()` protecting `/app/**`; public routes `/`, `/sign-in`, `/sign-up`, `/health`.
- [ ] Build `(auth)` route group: `/sign-in` (Clerk `<SignIn/>`), `/sign-up`, Google + email/password buttons matching Clerk config used on mobile.
- [ ] Build `(app)` route group shell `web/app/(app)/layout.tsx`: authenticated wrapper, provider tree (theme + courses data), top bar, and an app-wide tab nav (Home / Courses / Create / Study / Profile) as a sticky top nav on desktop and bottom nav on mobile viewports.
- [ ] Port the API client: `web/lib/api.ts` — typed `fetch` wrapper reading `NEXT_PUBLIC_API_URL`, injecting `Authorization: Bearer <clerk token>` via `clerkClient`'s `getToken()` (server) and `useSession().session.getToken()` (browser), returning typed errors matching the backend `{ error }` shape.
- [ ] Port `Sua/src/lib/types.ts` → `web/lib/types.ts` (Course, Note, Flashcard, Quiz, Asset, Job, ChatMessage, Scheduling fields).
- [ ] Onboarding parity: after first sign-up, redirect to `/onboarding` — university, programme, level, optional exam date; on finish POST the first course(s) via `POST /api/courses` (auto-create first course), then land on Home.
- [ ] Wire sign-out, and ensure `GET /api/me` works from the browser (verify `ensureUser` provisions a row for a fresh Clerk user).

**Files:** `web/middleware.ts`, `web/app/(auth)/(sign-in|sign-up|onboarding)/…`, `web/app/(app)/{layout.tsx,home/page.tsx}` (empty-state placeholder), `web/lib/{api.ts,types.ts}`.

**Done when:** A new Clerk user can sign in on web, finishes onboarding, and sees the Home placeholder with their first course; an existing mobile-created user signs in and sees their existing courses; `GET /api/me` + `GET /api/courses` succeed from the browser.

---

### Milestone 2 — Courses and notes (CRUD)

- [ ] Courses tab `/app/courses`: list from `GET /api/courses` with name, code, exam countdown chip, colour dot, archived filter; empty state.
- [ ] Course create/rename/archive/delete modals mapping to `POST/PATCH/DELETE /api/courses`, including delete confirmation + "move notes elsewhere" option (backend behavior dependency check).
- [ ] Note list per course at `/app/courses/[id]`: `GET /api/notes/course/:courseId`; group by source type (typed / recording / upload); show per-note status (no-summary `pending`, study-set `ready`), and per-note "open" target.
- [ ] Note viewer `/app/note/[id]`: title, body rendered via the ported markdown parser (headings, bold, bullets, numbered lists, transcript section for audio notes), text-size affordance from preferences (M6), and "study set" panel reading `GET /api/note/:noteId/study` (cards + quizzes).
- [ ] Typed editor `/app/create?type=typed`: autosave to `POST /api/notes/sync` (upsert, 2s debounce); includes the markdown toolbar (port `Sua/src/lib/markdown.ts` transform helpers verbatim).
- [ ] Cross-page parity: notes can move between courses (two-tap move) via `PATCH`.
- [ ] Error states: retry buttons for API failures; skeleton loaders for all fetches.

**Files:** `web/app/(app)/(courses)/…`, `web/app/(app)/note/[id]/page.tsx`, `web/app/(app)/create/page.tsx`, `web/components/markdown.tsx` (parser + renderer), `web/lib/markdown.ts`.

**Done when:** CRUD for courses and typed notes is fully exercised (create → view → edit → move → delete), autosave works without a full reload, markdown renders identical output to mobile for a fixed sample doc, and every list has loading/empty/error states.

---

### Milestone 3 — Capture: uploads and recording (stretch = recording)

- [ ] Upload flow: pick file (browser `<input type=file>` with accept lists matching `/sign` allowlists) → `POST /api/uploads/sign` → multipart to Cloudinary with on-progress UI (XMLHttpRequest for progress events) → `POST /api/uploads/:id/complete` → poll `GET /api/jobs/note/:noteId` → redirect to the note.
- [ ] Document-to-note pipeline: sign with `task: summarise` (task parameter supported for documents/images) so transcription/summary runs server-side after upload completes.
- [ ] Enforce 25 MB client-side with a clear rejection message.
- [ ] Create tab `/app/create` with three cards (Type, Upload, Record — Record disabled "coming soon" until the end of this milestone).
- [ ] Recording (**stretch, last item of M3**): MediaRecorder in browser (`getUserMedia` permission flow). Constraints: `.wav` or `.ogg` output (matches `/sign` audio allowlist — does not use segmented m4a, since MediaRecorder chunk moov semantics differ; single blob per take ≤ 60 min); pause/resume via recorder state; visible timer; warning beyond free-tier limits; flush to the upload flow on stop; segment cap and free-tier gate honoring `POST /api/me` usage data.
- [ ] Voice note defaults: if the `task`-gated pipeline is unavailable for audio, the recorded note saves with a `transcription-pending` state and the student can trigger it from `POST /api/jobs` with `kind: study_set` (already supports audio notes on the backend).

**Files:** `web/app/(app)/create/page.tsx`, `web/components/upload-file.tsx`, `web/components/record.tsx` (stretch), `web/lib/uploads.ts` (sign → upload → complete → poll helper).

**Done when:** A PDF upload produces a note with an extracted-text summary + flashcards + quiz; an image upload produces the same via OCR task; artifacts from rejected formats/size show clear errors; recording (if shipped) produces a playable, transcribed note.

---

### Milestone 4 — AI pipeline visibility and Ask Sua

- [ ] Job status UI: sub-page/sidepanel reading `GET /api/jobs/note/:noteId` — stages Uploading → Processing → Transcribing → Summarising → Making cards → Ready; live polling every 5s while any job is `queued`/`running`; failure shows `attempts`/`error` with a "Try again" button hitting `POST /api/jobs` again (backend dedupes active jobs).
- [ ] Note detail integrated: summary sections (Overview / Key Points / Key Terms / Formulas / Likely Exam Questions) render from the note record once the job completes.
- [ ] Report-a-mistake: button on each summary, flashcard answer and quiz question wired to `POST /api/jobs/feedback` (mirror mobile's `report-mistake` UX and payload).
- [ ] Ask Sua `/app/ask-sua`: course + note context picker (whole course or specific notes); chat thread via `POST /api/chat/ask` and history via `GET /api/chat/messages` (newest restored on load); every answer shows source-note chips linking to the note viewer; "Explain simply / Give an example / Quiz me on this" quick actions; fallback copy when sources are missing (general-knowledge-label).
- [ ] Free-plan meter: read the usage object from `GET /api/me` and show assistant-question + summaries counters on Home and Ask Sua; disable composer with an upgrade CTA when a cap is hit (403 from backend is the source of truth).
- [ ] Markdown answers render through the same web markdown renderer as notes.

**Files:** `web/app/(app)/(ai)/jobs/…`, `web/app/(app)/ask-sua/page.tsx`, `web/components/job-status.tsx`, `web/components/chat-bubble.tsx`.

**Done when:** A generated note shows live status → completion within its pipeline time (fails gracefully after 3 attempts); Ask Sua answers from chosen course context with visible citations; caps display and enforce.

---

### Milestone 5 — Study: daily review, decks, quizzes

- [ ] Home "Daily Review" card: due count + progress bar + streak, plus 7-day progress. Note: the mobile app computes streak/7-day progress **locally from SQLite**; the web version needs a server aggregate. **Check first whether a suitable endpoint exists; if not, add a small `GET /api/study/home-summary` backend route in this milestone (additive Prisma read, no RLS changes).**
- [ ] Review session `/app/review`: turned-over cards, Again / Hard / Good / Easy grading with SM-2-lite constants matching the backend exactly (ease base 2.5, floor 1.3, Again 10 min, Good 1d/6d/×ease, Easy 4d/×ease×1.3); online-only in MVP — each grade POSTs to `/api/study/sync/reviews` immediately; session-length preference caps the queue (M6).
- [ ] Deck view `/app/deck/[id]`: card list with per-card due hints, manual create (`POST /api/study/notes/:noteId/cards`), edit (`PATCH /api/study/cards/:cardId`), delete.
- [ ] Quiz view `/app/quiz/[id]`: MCQ / true-false instant grade + explanation reveal; short answers POST to `/api/study/attempts` then poll `GET /api/study/attempts/:id` until AI marking completes (progress ring while waiting); results screen with score, missed questions, and Make-cards-from-mistakes (bulk `POST /api/study/notes/:noteId/cards`).
- [ ] Notes viewer cards deep-link into deck/quiz tiles (already present in `/note/[id]` study panel from M2).

**Files:** `web/app/(app)/{review,deck/[id],quiz/[id]}/…`, `web/components/{flashcard.tsx,quiz-question.tsx}`, `web/lib/srs.ts` (port of `Sua/src/lib/srs.ts` constants).

**Done when:** A student completes a full study loop on web only — review session → progress visible on Home; quiz attempt → AI-marked in background → results + mistake-cards; all mutations visible in the mobile app after its next pull (shared NeonDB data confirms cross-platform parity).

---

### Milestone 6 — Profile, preferences and appearance

- [ ] Profile hub `/app/profile`: account info (`GET /api/me` + `PATCH /api/me`), avatar (Clerk-managed), plan badge (Free; Pro badge renders when plan data exists — no billing CTA beyond "Upgrade coming on mobile"), monthly recordings/summaries meter.
- [ ] Preferences screen `/app/preferences`, mirroring the mobile screen minus mobile-only rows:
  - Appearance: System / Light / Dark → sets `data-theme` attr + class; reuses the ported `lightVars`/`darkVars` and reads the OS preference as default via `prefers-color-scheme`.
  - Review session length (10/20/30, clamped 5–50).
  - Note text size (small/medium/large → 14/16/20) applied to the note viewer.
  - Remember-last-capture-course: persisted in `localStorage`, defaults the Create form. (No SQLite — KV lives client-side.)
- [ ] AI settings from PRD §6.10 where free/cheap (summary length preference: short/standard/detailed; language: English) — read from preferences; POSTable where the backend accepts it, otherwise visual-stub pending backend support. Backend dependency check first; stub if missing.
- [ ] Data controls: "Clear offline storage" is a mobile-only concept → replaced by a Web preview of account data; account + data deletion is `POST /api/me/delete` behind a typed confirmation (matches mobile UX parity of the danger zone).
- [ ] Security: link to the Clerk account portal (same URL as mobile's `EXPO_PUBLIC_CLERK_ACCOUNT_PORTAL_URL`).
- [ ] Accessibility pass: `aria-label` on every icon button, focus rings on the app shell, contrast audit against dark palette, reduced-motion respect for card flips (media query).

**Files:** `web/app/(app)/{profile,preferences,prefs-*}/…`, `web/lib/prefs.ts`, style overrides in `web/app/(app)/globals.css`.

**Done when:** The whole account surface (edit / preferences / delete) is usable on web, dark mode toggles read and look identical to mobile, an unused-edge case (delete flow, plan gates) behaves per the PRD, and zero hard-coded colors remain in `web/`.

---

### Milestone 7 — Verification, hardening, and Vercel deploy

- [ ] Cross-platform data parity checklist (manual QA): a shared Clerk user edits note → posts course → takes quiz → deletes flashcard on web → confirm each view on mobile; reverse direction too.
- [ ] Lighthouse/Next audit: <100 KB JS per route where possible; images OK without `next/image` for user content; loading skeletons on every screen; tone/wording typo sweep against the PRD voice ("Sua", "study set", "likely exam questions").
- [ ] Privacy/observability: no Cloudinary secrets ever in browser code (verify bundle grep); no student content in client errors (PostHog-style client digest only, matching backend policy); web console errors tracked through Vercel logs.
- [ ] Accessibility + performance checkoff: tab order, screen reader labels, keyboard-only flow sign-in → review a card → submit quiz.
- [ ] Deployment: `vercel link` `web/`; env vars `NEXT_PUBLIC_API_URL`, Clerk publishable/secret; backend `CORS_ORIGIN` + trusted Clerk Sign-in-URL per deployed domain; Vercel preview on PRs.
- [ ] Write `web/README.md` (structure, run instructions, deployment notes) and a short section inside the root `README.md` or `AGENTS.md`.
- [ ] Mark `web/` ship status inside `todo.md` with a "Milestone ∙ Web MVP" block linking back to buildstep.md and recording the deferral notes below.

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
