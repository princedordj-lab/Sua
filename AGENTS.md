# Sua — Agent Instructions

Sua ("soo-ah") is an offline-first exam-prep app for African university students: lectures, slides and typed notes become summaries, flashcards and quizzes. There is **no root `package.json` or workspace config** — three independent npm projects, each installed and run from its own directory:

| Path | What it is |
| :--- | :--- |
| `Sua/` | Expo SDK 57 / React Native 0.86 / React 19 app (the product) |
| `backend/` | Express 5 API (JS ESM) + BullMQ worker, Prisma 7 + Neon Postgres, Clerk auth |
| `web/` | Next.js 16.4 web app — marketing landing, `/health`, and the signed-in product under `/app/*` |

Nested instruction files are authoritative for their directory: `Sua/AGENTS.md` (Expo rules — fetch the SDK 57 docs, do not trust memory) and `web/AGENTS.md` (Next.js 16 block, rewritten by `next dev`; commit it rather than reverting). `README.md` is a stale copy of an older AGENTS file — trust this file and the code over it.

## Commands

Mobile (`cd Sua`):
```bash
npx expo install <pkg>   # never npm install for Expo/RN deps — pins SDK-compatible versions
npx tsc --noEmit         # typecheck
npx expo lint            # eslint (eslint-config-expo)
npm run android          # expo run:android — project uses expo-dev-client, so use a dev build
npx expo prebuild        # after app.json/plugin changes; never hand-edit android/ or ios/
```

Backend (`cd backend`):
```bash
npm run dev              # API on :4000 (tsx watch)
npm run worker           # BullMQ worker — AI jobs never finish without this second process
npx prisma migrate deploy   # apply migrations to the Neon dev DB (uses DIRECT_URL)
npx prisma generate         # after schema edits; client goes to gitignored src/generated/prisma
npm run build               # esbuild bundle -> dist/index.js (Vercel build)
npm run eval -- <sample> --kind lecture_note|reference   # prompt/validation harness
```

Web (`cd web`): `npm run dev`, `npm run build`, `npm run lint`.

There is **no test suite**. Verification is `npx tsc --noEmit` + `npx expo lint` (mobile), `npm run build` (backend/web); for backend-only edits an `npx esbuild <files> --outdir=.tmp --format=esm` parse pass is enough.

## Backend invariants

- Every request-scoped query goes through `withUser(clerkId, tx => …)` (`src/lib/db.js`), which sets `app.current_user_id` inside a transaction for the RLS policies. Gotcha: the Neon role behind `DATABASE_URL` (`neondb_owner`) has **BYPASSRLS**, so the database does not enforce isolation today — the convention does. Use direct `prisma` only for cross-user/infra work (`lib/pipeline.js`, `worker.js`, usage counters). Keep external I/O outside `withUser`; its transaction times out after 15s.
- Migrations are numbered `0_init` … `12_reference_usage`; **next is `13_…`**. No timestamps: Prisma replays directories lexicographically, so `2026…` sorts before `2_notes`. Never edit or rename an applied migration — append a new one.
- Prisma uses a custom ESM client output (`src/generated/prisma`, gitignored). CLI URLs come from `prisma7.config.ts` → `DIRECT_URL`; the running app uses pooled `DATABASE_URL` via `@prisma/adapter-pg`. The generator's `importFileExtension = "js"` is load-bearing for deploys: the files are generated as `.ts`, and both esbuild and Vercel's builder emit `.js` in place, so `.js` specifiers resolve. Setting it back to `"ts"` (which only `tsx` can chase) makes the deployed function die at import with `ERR_MODULE_NOT_FOUND: .../internal/class.ts`.
- Plain JS ESM (`"type": "module"`) — no TS build step. API entry `src/index.js`, worker `src/worker.js`. Vercel serves that same file: it auto-detects the Express app from the default export at `src/index.js` and routes every path to it. Do **not** add a `backend/api/` directory — files there claim the `/api` prefix in Vercel's filesystem router, so `api/index.js` answers `/api` exactly and every real route (`/api/health`, `/api/notes/sync`, …) dies with a platform-level `404 NOT_FOUND` before Express runs.
- Public routes are `/`, `/api/health` and the Clerk webhook (mounted before `express.json()` because svix needs the raw body); every other router sits behind `authenticate`.
- Uploads are sign → direct PUT to a short-lived Neon Object Storage URL → complete. `/complete` verifies the object and enforces size, then extracts document text inline (PDF/DOCX/PPTX/PPT/TXT/MD ≤ 25 MB, 100k-char cap). Extraction failure returns `null` and **must not fail the upload**. Cloudinary remains a compatibility fallback until its migration window closes. All 16 media formats are supported across ingestion: Documents (`pdf`, `docx`, `pptx`, `ppt`, `txt`, `md`), Images (`jpg`, `jpeg`, `png`, `webp`, `heic`, `heif`), and Audio (`m4a`, `mp3`, `wav`, `ogg`, `aac`).
- PDF extraction depends on `@napi-rs/canvas` being imported from `src/lib/extract.js` with a *literal* specifier before `pdf-parse` is loaded: pdfjs-dist evaluates `new DOMMatrix()` at module scope, and its own `createRequire` lookup is invisible to Vercel's file tracer (missing package → `ReferenceError: DOMMatrix is not defined` at boot). Both imports must stay lazy so a missing native binary degrades PDF text to `null` instead of crashing every route on import.
- Long-running AI work belongs to BullMQ. Free-plan caps (`FREE_MONTHLY_*`) are warn-only until billing ships.
- Never log or return `NEON_API_KEY`, Clerk secrets, or signed URLs beyond their TTL.

## AI generation contract (server owns it)

`Job.kind` is one of `study_set | lecture_note | course_reference`; `Note.noteKind` is `note | reference`.

- `study_set` — summary + flashcards + quiz; note `body` untouched. Outputs strictly conform to `backend/src/config/study-pack-schema.js` (`shortSummary`, `keyTerms`, `formulas`, `examQuestions`, `flashcards`, `quiz`).
- `lecture_note` — AI rewrites `body`, original capture preserved in `transcript`, then summary + cards + quiz (typed notes included).
- `course_reference` — condensed reference sheet only, no cards/quiz; one page per upload.
- Context budgeting: notes must have at least 40 characters to generate; material is clamped to `60,000` characters before dispatching to the LLM to prevent context overflow.
- Validation: AI outputs undergo strict schema validation; if the first pass fails, a strict retry at temperature `0` is executed before failing.
- Persistence: flashcards and quizzes are stored in normalized relational tables (`flashcards` with SM-2 spaced repetition fields: `ease: 2.5`, `intervalDays: 0`, `reps: 0`, `dueAt: now()`, and `quizzes`/`quiz_questions`). Regeneration idempotently replaces existing cards/quizzes for the note.
- `pipeline.startAttempt` re-asserts `noteKind`; `POST /jobs` returns **409** when a non-reference kind targets a `reference` note; references increment `Usage.references`, not `summaries`.
- Client side: `Sua/src/lib/generate.ts` (`generationKindFor`, queue drain, finishers, `reconcileAiOutputs`) and `create.tsx` (`jobKindForTarget` / `noteKindForTarget`). Pending notes are synced **before** `POST /jobs` or the server 404s. Upload-triggered conversions have no local queue row, so `reconcileAiOutputs` backfills cards/quiz.
- When touching this area, update all four layers together: Prisma schema/usage, `pipeline.js`, `routes/jobs.js`, and the mobile queue/UI copy.

## Mobile conventions

- Styling: NativeWind `className` only; the `style` prop is allowed **only** on `SafeAreaView`. Colors are CSS variables declared in `Sua/tailwind.config.js` and remapped for dark mode by `Sua/src/state/appearance.tsx`; use `colors` from `Sua/src/config/theme.ts` for icon/style values instead of hex literals. Gold is fill-only (never text), one gold button per screen, 48px minimum tap targets.
- Never add or remove `--tw-*` utilities (`shadow-*`, `ring-*`, transform, gradient, `vars()`) after an element's first render: NativeWind's dev-only upgrade warning crashes with a bogus "Couldn't find a navigation context" (nativewind#1812). Keep those utilities static and toggle plain values such as `opacity-*`. Note `bg-gold/60` omits `--tw-bg-opacity` while `bg-gold` sets it, so alpha/non-alpha toggles on one element are unsafe too.
- Routes live in `Sua/src/app`; shared components/hooks/libs stay outside it. `@/*` maps to `Sua/src/*`.
- SQLite migrations are the `MIGRATIONS` array in `Sua/src/lib/notes.ts`, tracked by `PRAGMA user_version`. Append a step; every step must be idempotent because fresh installs replay all of them and a throw retries on next launch.
- Sync: the client pushes `updatedAt`; the server rejects stale writes; pulls use pending-safe upserts so a locally pending note is never clobbered. Drain order is notes **then** uploads (uploads may reference an unsynced note), and the persisted Wi-Fi-only toggle must be respected.
- Recording: 2-minute m4a segments with unique filenames; only `finalized` segments upload. On crash recovery drop the in-progress segment (truncated m4a is unplayable) and resume from the finalized ones.
- Markdown: note bodies render through the in-house subset parser (`Sua/src/components/markdown.tsx` + `lib/markdown.ts`), not a third-party renderer (React 19 compatibility). The editor *input* uses `react-native-enriched-markdown` (math/code/video disabled in `package.json`).
- Every screen must work offline except AI generation and Ask Sua.

## Web conventions (`web/`)

- Next.js **16.4** (App Router, React 19, Tailwind v4, Turbopack). Read `web/AGENTS.md` + `node_modules/next/dist/docs/` before using framework APIs — `middleware.ts` is now `proxy.ts`, and layouts use generated `LayoutProps<"/path">` types.
- **Cache Components is enabled:** any client hook reading URL data (`usePathname`, `useParams`, `useSearchParams`) needs a `<Suspense>` boundary above it or dynamic-param prerendering fails (`blocking-prerender-client-hook`). See `components/app-shell.tsx`.
- Clerk is v7 (Core 3): `<SignedIn>/<SignedOut>/<Protect>` throw in client components — use `useAuth()`. Protected routes are `/app/*`; public are `/`, `/health`, `/sign-in(.*)`, `/sign-up(.*)`.
- Product routes live under `web/app/app/…` so URLs read `/app/home`, `/app/note/[id]`, etc. Shared components/libs stay in `web/components` and `web/lib`; `@/*` maps to `web/*`. Note creation (`/app/create`) enforces a 40-character minimum note length for generation; Note view (`/app/note/[id]`) embeds `FlipCardViewer` on the Cards tab (3D flip reveal + SRS review launch) and `InlineQuizPlayer` on the Quiz tab with real-time answer verification, explanations, and score tracking.
- Styling mirrors mobile tokens: CSS variables in `app/globals.css`, `colors` from `web/config/theme.ts` for JS values, screen styles in `web/app/app.css`. No hex literals in components; gold is fill-only, one gold button per screen, 48px tap targets. Tailwind utilities are fine alongside `.class` names. Keep every web route within mobile viewport widths; follow the responsive layout and overflow-audit rules in `web/AGENTS.md` and do not mask horizontal overflow on `html` or `body`.
- Data access goes through the same Express routes as mobile using `lib/api.ts` + `useApi()` (Clerk bearer token) and `useResource` for fetch-on-mount/retry. Never call Postgres directly. Web-only server reads must stay **additive** (`GET /api/study/home-summary`, `/study/sets`, `/study/due?ahead=`, `/study/quizzes/:quizId`, `/notes/:noteId`).
- Online-first by design: no offline queue, IndexedDB cache or sync layer; preferences persist in `localStorage` (`web/lib/prefs.ts`), not SQLite.
- Note ids are client-generated (`crypto.randomUUID()`) and must be synced before `POST /jobs`; the SRS constants in `web/lib/srs.ts` must stay identical to `Sua/src/lib/srs.ts` and `backend/src/lib/srs.js`.
- Verify with `npx tsc --noEmit`, `npx eslint .`, `npm run build`.

## Environment & deploy

- `backend/.env` (copy `backend/.env.example`): pooled `DATABASE_URL`, direct `DIRECT_URL`, Clerk keys + webhook secret, Neon storage (`NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_BRANCH_ID`, `NEON_STORAGE_BUCKET`), `REDIS_URL`, `GEMINI_API_KEY` (transcription/OCR), `XKIRO_API_KEY` (text generation via the OpenAI-compatible xkiro API; model from `AI_BULK_MODEL`/`AI_STRONG_MODEL`, default `qwen/qwen3.8-max:free`).
- `Sua/.env.local` (copy `Sua/.env.example`): `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_API_URL`. Android emulator needs `http://10.0.2.2:4000/api`; `api.ts` falls back to that when unset.
- Backend deploys to Vercel from `backend/` (`vercel.json` → `npm run build`); the AI worker needs a long-running host with Redis, not a serverless function.

## References

- `buildstep.md` — web MVP build log; `todo.md` — build checklist (may lag the code).
- `Sua — Project Overview.md`, `Sua — Product Requirements Document (PRD).md` — local, untracked product docs.
- `Sua/src/lib/notes.ts` (local schema + sync), `backend/src/lib/pipeline.js` (AI stages), `backend/src/routes/uploads.js` (storage flow).
