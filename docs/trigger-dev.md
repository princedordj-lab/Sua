# Document processing (Trigger.dev)

Sua processes documents on **Trigger.dev Cloud**. The Express API stays on Vercel and only
writes state and triggers a run; nothing extracts, OCRs or generates inside an HTTP request.

```
Expo / Web ──POST /api/uploads──────────▶ API: sign Neon Object Storage PUT (asset row, status=pending)
           ──PUT  (direct to storage)───▶ Neon Object Storage
           ──POST /api/uploads/:id/complete▶ API: verify object, set asset active + extractState=pending,
                                                  ensure job row (unique idempotencyKey), trigger
                                                  process-document, return 202 + processing
Trigger.dev ─▶ process-document
                 ├─ extract-document   (PDF local text first, OCR only unreadable pages, PPTX/DOCX/TXT)
                 ├─ prepare-source     (normalize, condense, persist AI-ready text on the job row)
                 ├─ generate-notes     (own run, own retries)
                 ├─ generate-summary   (own run)
                 ├─ generate-flashcards(own run)
                 ├─ generate-quiz      (own run)
                 └─ finalize-document  (usage, note.aiState, completion push)
```

## Why it is shaped this way

| Old behaviour | Now |
| --- | --- |
| Custom Postgres queue (`FOR UPDATE SKIP LOCKED`) drained by a Vercel runner + daily cron | Trigger.dev scheduling, retries, concurrency and run history |
| One 240 s invocation budget → jobs yielded at "Pulling out the important parts" | Each stage is its own run; long documents are not bound to an HTTP budget |
| All materials in one model call — a quiz failure lost the summary too | One stage per material; a failure keeps everything already saved |
| Prisma transaction held across model/storage calls (P2028) | One short statement per state change, no transaction around I/O |
| Model JSON used without shape checks → `Cannot read properties of undefined (reading 'map')` | Every response validated (`MATERIAL_SPECS[...].validate`) before any property is read |
| Blind retries of permanent errors | Transient (429/5xx/timeout/network/capacity) retried with backoff + `Retry-After`; permanent (auth, quota, invalid file, unreadable) aborts the run |

## Database

Migration `22_trigger_processing` adds to `jobs`: `processingVersion`, `processingState`,
`triggerState`, `idempotencyKey` (unique), `runId`, `materials` (jsonb), `errorCategory`,
`sourceText`, `sourceMeta`.

```bash
cd backend && npx prisma migrate deploy   # uses DIRECT_URL
```

`GET /api/jobs/:id` keeps its old fields and adds `processing` (`state`, `detail`, `materials`,
`completedMaterials`, `canRetry`, `runId`). States: `uploaded → queued → extracting →
ocr_processing → generating → completed | failed | cancelled`.

## Environment variables

**Vercel (API)** — existing ones plus:
- `TRIGGER_SECRET_KEY` (Trigger.dev → Project → API keys, *server* key only)

**Trigger.dev (Project → Environment variables)** — Vercel variables are **not** shared:
- `DATABASE_URL`, `DIRECT_URL`
- `NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_BRANCH_ID`, `NEON_STORAGE_BUCKET`
- `GEMINI_API_KEY`, `XKIRO_API_KEY` (and any `AI_*`, `LLAMAPARSE_*`, `OCR_*` overrides)
- optionally `LLAMA_CLOUD_API_KEY`, `CLOUDINARY_*` (legacy fallback)

**CLI / deploy machine**: `TRIGGER_PROJECT_REF` (in `trigger.config.ts`), `TRIGGER_ACCESS_TOKEN`
for non-interactive deploys.

Never expose `TRIGGER_SECRET_KEY` to Expo or the browser.

## Commands

```bash
cd backend
npm run trigger:dev         # local worker against your dev project
npm run trigger:deploy      # deploy tasks to the staging environment
npm run trigger:deploy:prod # deploy to production
npm run test:processing     # offline architecture checks (no network, no DB)
```

Vercel: unchanged (`npm run build` → `src/index.js`, `maxDuration` 300). The cron in
`vercel.json` now only runs the janitor (storage deletions, tombstones, reminders, streak
notices) — document processing never runs on a schedule.

## Retries and recovery

1. A stage throws → Trigger.dev retries that **stage** (4 attempts, exponential + jitter);
   `catchError` returns `retryDelayInMs` from the provider's `Retry-After` on a 429.
2. A permanent failure is recorded on the material and the run is not retried.
3. `POST /api/jobs/:id/retry` resets only the failed/pending materials and triggers the
   document again; finished materials stay on the row and their stages skip (`skipped`).
4. Extraction and the AI-ready source text are persisted before any generation starts, so a
   generation failure never repeats reading or OCRing the file.
5. The DB-write / trigger-API boundary is not atomic: if the trigger call fails the row stays
   with `triggerState=failed` and a retry re-submits it; the run adopts its own id at start
   (`adoptRunId`) and Trigger.dev deduplicates on `sua:process:<note>:<kind>:<version>`, so a
   repeated completion cannot create a second run.

## Known limitations

- The notes stage picks its writer by size, not by file type. A document whose stored
  page text (plus any typed context) fits `SHORT_SOURCE_CHARS` (60k) is written in one
  call — `singlePassSource`/`assembledShortSource` in `lib/note-pipeline.js` — so map/reduce
  is never paid for on a short upload; a note that mixes a document with photos is
  assembled first, because pictures have no chunk rows and the sectioned writer would drop
  them. Only when both return null does `lib/long-doc.js` run, and it then produces the
  summary/cards/quiz for that document too, so the per-material stages see them as done.
- `partial` extraction (a parked LlamaParse parse) is reported honestly as
  "Processing scanned pages"; the run resumes on the next attempt.
- Trigger.dev machine presets and concurrency caps are configured per task
  (`extract-document` medium-1x/c4, materials small-1x/c6) and can be tuned in
  `src/trigger/stages.ts`.
