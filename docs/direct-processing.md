# Sua Direct Processing Architecture

This document describes the direct Express-based document processing architecture for Sua, replacing Trigger.dev with native Express orchestration, PostgreSQL atomic leases, and Vercel background execution (`waitUntil`).

---

## Architecture Overview

```
Mobile Application / Web
        │
        ▼ (POST /api/uploads/complete or POST /api/jobs)
Express API (Vercel Serverless)
        │
        ├─► Fast Intake: verify storage, create/find Job, acquire lease
        │   Returns 200/201 with job status immediately
        │
        └─► Background Execution (Vercel waitUntil / setImmediate)
                │
                ▼
        Direct Orchestrator (`src/lib/processing/orchestrator.js`)
                │
                ├─► 1. Acquire Lease (`lockedUntil`, `heartbeatAt`)
                ├─► 2. Resumable Extraction (`extractStage`)
                ├─► 3. Normalization & Source Prep (`sourceStage` & `normalization.js`)
                ├─► 4. Material Generation (Notes, Summary, Flashcards, Quiz)
                │       - Idempotent: completed materials preserved
                │       - Checkpointed in PostgreSQL
                └─► 5. Finalize & Notify (`finalizeStage`)
```

---

## 1. Immediate Processing & Vercel Execution

- **Zero Blocking during Requests**: Routes (`POST /api/uploads/complete`, `POST /api/jobs`, `POST /api/jobs/:id/retry`) respond immediately with the current job state and run ID.
- **Background Runner (`src/lib/processing/start.js` -> `runInBackground`)**:
  - Uses `@vercel/functions` `waitUntil()` when available in Vercel serverless environments.
  - Falls back to `setImmediate()` in local development / standard Node.js runtime.
- **Budget & Execution Window**:
  - Controlled by `src/lib/budget.js` (`PLATFORM_MAX_DURATION_MS`).
  - Orchestrator checks remaining budget before each AI stage. If insufficient execution time remains, it yields cleanly so status polling or retries can resume from that point.

---

## 2. PostgreSQL Concurrency & Lease Ownership

- **Atomic Leases**:
  - Managed by `acquireProcessingLease()` and `extendProcessingLease()` in `src/lib/processing/state.js`.
  - Condition: `lockedUntil IS NULL OR lockedUntil < NOW()`.
  - Lease window: `PROCESSING_LEASE_MS` (default 5 minutes, renewed after extraction and each material stage via `heartbeatAt`).
- **Recovery of Expired Leases**:
  - If an invocation terminates unexpectedly, the lease naturally expires after 5 minutes.
  - The next status poll (`GET /api/jobs/:id` or `GET /api/notes/:id`) detects stale/expired jobs via `needsResubmit()` and re-triggers background processing safely.
- **Idempotency**:
  - Unique constraint on `jobs.idempotencyKey` (`sua:process:{noteId}:{kind}:{processingVersion}`) prevents duplicate job rows.

---

## 3. Dedicated Normalization Layer (`src/lib/normalization.js`)

The normalization service guarantees consistent, clean, and safe extraction outputs prior to AI consumption:

- **Validation (`validateExtractorOutput`)**:
  - Validates extractor structures: checks for missing or empty `sections`/`segments`.
  - Rejects completely empty documents with explicit `ExtractionValidationError` (`EMPTY_DOCUMENT`).
  - Never performs unchecked `.map()` operations on optional extractor fields (`asArray` utility).
- **Text & Structure Normalization**:
  - `cleanWhitespace`: Collapses non-standard whitespace, tabs, and duplicate blank lines while preserving indentation.
  - `cleanRunningHeadersAndFooters`: Detects and removes repeating headers/footers across consecutive pages.
  - `formatAiReadyText`: Normalizes headings, subheadings, and page/slide references into structured Markdown.
  - `normalizeDocument`: Calculates character and word counts, clamps output to configured limits with `truncated: true`.

---

## 4. AI Generation & Partial Completion

- **Material Stages**:
  - Notes (`generate-notes`)
  - Summary (`generate-summary`)
  - Flashcards (`generate-flashcards`)
  - Quiz (`generate-quiz`)
- **Stage Isolation**:
  - Each material records its own state in `jobs.materials` (`{ notes: { state: "done", at: ... }, ... }`).
  - If a stage fails (e.g. transient 429 rate limit or timeout), already completed materials are strictly preserved.
  - Subsequent retries resume from the earliest incomplete material without re-running finished stages or re-reading source documents.

---

## 5. Client Status Contracts & Compatibility

The API preserves the existing mobile and web status contract:
- **`processingState`**: `uploaded` | `queued` | `extracting` | `ocr_processing` | `generating` | `completed` | `failed` | `cancelled`.
- **`triggerState`**: Preserved for backward compatibility (`none` | `submitting` | `submitted` | `failed`).
- **`runId`**: Generates synthetic execution IDs (`run_<timestamp>_<random>`) so client polling and diagnostics continue uninterrupted.

---

## 6. Testing & Verification

All pipeline capabilities are verified offline without live database or external network access:

```bash
# In backend/
npm run test:normalization   # Normalization layer & boundary handling
npm run test:recovery        # Direct orchestrator leases, yields, resume & rate-limits
npm run test:processing      # Processing architecture and failure classification
npm run test:extraction      # Document extraction pipeline
npm run test:pdf             # Local-first PDF extraction and OCR fallbacks
npm run test:llamaparse      # LlamaParse parser integration
npm run test:ai              # AI error taxonomy and Retry-After handling
npm run test:budget          # Invocation budgets and yield calculations
npm run test:dedupe          # Job deduplication and heartbeat liveliness
npm run test:uploads         # Upload intake and verification
npm run build                # Single-bundle esbuild verification
```

