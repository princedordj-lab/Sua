# Sua Direct Processing Architecture

How an upload becomes a study set. This document reflects the current code:
direct Express orchestration (no external queue), PostgreSQL atomic leases,
Vercel background execution (`waitUntil`), a local-first extraction pipeline,
and one server-side rescue sweep that no longer depends on the student's screen.

---

## Architecture Overview

```
Mobile Application / Web
        │
        ▼ (POST /api/uploads/complete or POST /api/jobs)
Express API (Vercel Serverless)
        │
        ├─► Fast Intake: verify storage, create/find Job, acquire lease
        │   Returns with job status + runId immediately
        │
        └─► Background Execution (Vercel waitUntil — registered synchronously)
                │
                ▼
        Direct Orchestrator (`src/lib/processing/orchestrator.js`)
                │
                ├─► 1. Acquire Lease (`lockedUntil`, `heartbeatAt`)
                ├─► 2. Resumable Extraction (`extractStage`)
                ├─► 3. Normalization & Source Prep (`sourceStage`, `normalization.js`)
                ├─► 4. Material Generation (Notes, Summary, Flashcards, Quiz)
                │       - completed materials preserved; checkpointed per section
                └─► 5. Finalize & Notify (`finalizeStage`)
```

Every stage is a plain function in `src/lib/processing/stages.js`, testable
offline. The API's whole participation is to write the row and launch the
background runner (`src/lib/processing/start.js`).

---

## 1. Extraction pipeline (per asset)

`src/lib/extraction.js` owns all external I/O for documents: storage read,
PDF parse, page render, provider parse, model reads. One pass has a hard time
budget (`EXTRACT_BUDGET_MS`, default 200 s); whatever it finishes is stored on
`SourceChunk` rows plus asset progress columns, so the next pass — same code,
any caller — continues from `asset.nextPage` and never repeats work.

**PDFs are local-first.** `pdf-parse` reads the embedded text layer per page
(page numbers preserved); a page is only sent to a model when its local text is
empty/layout noise (`classifyPageText`), and a page that renders blank is proved
blank locally (`isRenderedPageBlank`) instead of being OCR'd. Both the local
text parse and the page render are deadline-bounded (`PDF_PARSE_TIMEOUT_MS`,
default 60 s) — a pathological file yields its pass instead of stalling the
function past the ceiling.

**LlamaParse (`src/lib/llamaparse.js`, config in `config/ai-pipeline.js`)** is
the primary parser for DOCX/PPTX and the scan-fallback for PDFs when
`LLAMA_CLOUD_API_KEY` is set. Upload → v2 parse → one status check per extraction
pass, never a blocking poll inside a request. A parked parse sets
`extractState=pending` + `providerNextPollAt`, and the claim SQL respects that
backoff. A PDF only reaches the provider when its local pass found no usable
page (or a submitted parse is still parked). `LLAMAPARSE_FORMATS` decides which
formats may use the provider at all; `LLAMAPARSE_ENABLED=0` disables it.
Auth/quota failures are terminal; timeouts, exhausted retries, provider
FAILED/CANCELLED, 413 and empty results fall through to the local pipeline.

**Native reads (`src/lib/native-read.js`)** — the model reads the file itself
only where no local parser can recover content: a whole-file scan (first pass
only, one model read), or a single picture. DOCX/PPTX keep their text local
(Gemini cannot open OOXML) but the *pictures inside the file* are read in
batches and merged into the slide/section they belong to — an image-only deck
still produces text. `NATIVE_DOC_READ=0` disables the model path.

**Audio** (`m4a/mp3/wav/ogg/aac`) and **images** (`jpg/png/webp/heic`) are not
extracted at upload time. Their content is read inside the generation job
(`lib/note-pipeline.js`): audio is transcribed with Gemini — files above the
inline cap (~8 MB real bytes) go through the Files API once and are deleted
right after the read, so long recordings no longer die as 400s — and every
transcription/OCR result is persisted on the asset via `saveAssetText`
(`processing/stages.js`, first-write-wins) so a retried run never pays for the
same call twice. `ppt` (legacy binary) fails honestly with `UNREADABLE_PPT`.

---

## 2. LlamaParse state machine (asset provider columns)

| Asset state | Meaning | Who advances it |
|---|---|---|
| `extractState=pending`, no `providerJobId` | needs extraction | any `extractNext` caller |
| `providerJobId` + `providerNextPollAt` in future | parse parked on backoff | next claim after backoff |
| `providerStatus=PENDING/RUNNING` (polled) | still in flight | next claim |
| `providerStatus=FAILED/CANCELLED` | provider gave up → local fallback | local pipeline |
| `providerError` starts `LLAMA_GAVE_UP/…TIMEOUT/…EMPTY/…FAILED` | provider is finished for this asset | always local |
| `providerSubmittedAt` older than `LLAMAPARSE_TIMEOUT_MS` | parse deadline exceeded → local fallback | local pipeline |

`FOR UPDATE SKIP LOCKED` claims (`claimExtractionAsset`) double-run-protect
concurrent triggers. A `running` claim can be retried once it has been silent
past `STALE_RUNNING_MS` (8 min) — this is what rescues a pass a frozen
instance abandoned.

---

## 3. Concurrency & leases

- **Atomic leases**: `acquireProcessingLease()` / `extendProcessingLease()`
  (`state.js`), condition `lockedUntil IS NULL OR lockedUntil <= NOW()`,
  attempts bumped on acquire. Sizing: `leaseMsFor()` in `lib/budget.js` — never
  shorter than the pass it protects, always expiring within minutes if the
  instance dies.
- **Idempotency**: `jobs.idempotencyKey`
  (`sua:process:{noteId}:{kind}:{processingVersion}`), unique — a lost create
  race is a `P2002` that adopts the other row. Two devices, a double-tapped
  Retry, or a replayed `/complete` produce one row and one run.
- **Budget**: `lib/budget.js` (`PLATFORM_MAX_DURATION_MS` − `PROCESSING_SAFETY_MS`).
  The orchestrator yields before a stage it cannot finish inside the window.

---

## 4. Extraction → generation handoff (the eager handoff bug, fixed)

`extractStage` never reports work it does not have:

- **Parked provider** (`providerNextPollAt` in the future) → throws
  `TransientProcessingError PROVIDER_PARKED` with the poll's `retryAfterMs`.
  The old behavior — return `pending`, proceed into source preparation with
  zero pages, fail the job "unreadable" while the parse was minutes from done —
  is what specifically killed DOCX/PPTX conversions under a closed app.
- **Partial pass** (budget or caps) → throws
  `TransientProcessingError EXTRACTION_PARTIAL`; stored pages survive on
  `SourceChunk` rows and a retried pass continues from `nextPage`.
- **Failed extraction** keeps the permanent/transient taxonomy:
  unreadable/corrupt/missing are permanent (`UNREADABLE_FILE` …), provider
  trouble is transient.
- The orchestrator adds a second gate: anything that is not `done` never
  reaches `sourceStage`.

Transient throws mark the row `processingState=failed` with the classified
category (never provider text — `safeFailureMessage`), release the lease, and
the row is re-run by any of the rescuers in §5 after a short cooldown.

---

## 5. Rescuers — one funnel, many triggers

Recovery funnels through exactly two entry points: `extractNext` (assets) and
`retryProcessing` (jobs). Triggers:

| Trigger | Where | What it rescues |
|---|---|---|
| Second note read (`GET /api/notes/:id`) | `routes/notes.js` | `pending`/`partial` assets, stale-`running` passes, needsResubmit jobs |
| Job polls (`GET /api/jobs/:id`, `/note/:noteId`) | `routes/jobs.js` (`recoverRow`) | interrupted runs + transient failures |
| Sync tail (`POST /api/notes/sync`) | `routes/notes.js` → `notesAwaitingConversion` | conversions the client reopened; failed jobs are unsettled |
| `/complete` replay | `routes/uploads.js` | deduped by `needsExtraction`/idempotency; won't re-arm a row it already started |
| **Tick sweep** (`/api/internal/jobs/tick` → `lib/processing/sweep.js` → `resumeStalledWork`) | daily cron (Hobby cap) | **everything the above is not around for: stalled extraction claims (max 3 assets) and interrupted/transiently-failed runs (max 5 jobs), oldest first.** |

`needsResubmit` (`start.js`) is the predicate: `triggerState=failed`, unlocked
idle > 2 min, or — new — a `processingState=failed` row whose category is
transient after a 60 s cooldown. Permanent failures stay manual (Try again);
the sweep never re-spends them.

`runInBackground` registers `waitUntil` **synchronously** (static import,
matched by a try/catch outside request contexts): the dynamic-import version
queued registration behind a microtasks race, and a committed response froze
the function with the pass mid-flight — the row looked alive and nobody
resumed it.

---

## 6. Normalization (`src/lib/normalization.js`)

Guarantees clean, safe extraction output before AI consumption:

- `validateExtractorOutput`: validates structure (no missing/empty
  `sections`/`segments`), rejects empty documents (`EMPTY_DOCUMENT`),
  defensive `asArray` everywhere.
- `cleanWhitespace`, `cleanRunningHeadersAndFooters`, `formatAiReadyText`,
  `normalizeDocument` (counts, clamps, `truncated`).

---

## 7. AI generation & partial completion

- Materials (`notes`, `summary`, `flashcards`, `quiz`) write `jobs.materials`
  independently; a failure never removes another's result and a retry resumes
  at the earliest incomplete stage without re-reading the source
  (`job.sourceText` is persisted once by `sourceStage`).
- Long-file map/reduce checkpoints every digest and merge wave
  (`job.checkpoint`, durable-or-throw) so a yielded run resumes without
  re-paying; section writes are first-write-wins and merge batches are keyed
  by `stableBatchId()`.
- Model outputs are strictly validated; a failed first pass retries at
  temperature 0 before failing.

---

## 8. Client status contracts (unchanged)

- `processingState`: `queued | extracting | ocr_processing | generating |
  completed | failed | cancelled`.
- `triggerState`: `none | submitting | submitted | failed`.
- `runId`: synthetic (`run_<timestamp>_<random>`) survives trigger-result races
  via `adoptRunId`.
- Job dedupe is liveness-aware: `POST /jobs` uses `jobIsAlive` (`job-dedupe.js`)
  so a zombie `queued/running` row with a dead heartbeat cannot block a real
  request — the idempotency key adopts the row it never processed.

---

## 9. Testing & verification (offline; no DB / provider / network)

```bash
# in backend/
npm run test:pdf             # local-first PDFs, OCR fallback, quota, parked parses, resume
npm run test:llamaparse      # provider REST shapes + error taxonomy
npm run test:extraction      # per-format parsers
npm run test:extraction-deps # dependency-injection + pipeline regression suite
npm run test:rescue          # parked/partial yields, resumes, sweep predicate matrix
npm run test:processing      # stage orchestration + failure taxonomy
npm run test:single-pass     # typed context, study-set condense
npm run test:long-recovery   # hierarchical reduce resume
npm run test:merge           # merge durability + budget yield
npm run test:normalization   # normalization layer & bounds
npm run test:recovery        # orchestrator leases, recovery, budget yield
npm run test:ai              # provider error taxonomy, Retry-After
npm run test:budget          # invocation budget arithmetic
npm run test:dedupe          # job dedupe + heartbeat liveliness
npm run test:uploads         # upload intake + verification
npm run build                # esbuild single-bundle check
```
