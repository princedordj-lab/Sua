# LlamaParse extraction runbook

Sua uses LlamaParse (LlamaCloud v2 REST) as the **first** extractor for PDF,
DOCX and PPTX. Its output is stored in the existing `SourceChunk` table, so the
AI generation pipeline is unchanged. When the provider is disabled or gives up,
extraction falls through to the local-first PDF path / local Office extractor in
`backend/src/lib/extraction.js`.

## Files

| File | Role |
| :--- | :--- |
| `backend/src/lib/llamaparse.js` | Pure REST client: upload, create job, poll status, fetch markdown + credits. |
| `backend/src/lib/extraction.js` | Provider state machine (`tryLlamaParse`) and chunk persistence (`persistLlamaPages`). |
| `backend/src/config/ai-pipeline.js` | `llamaParse` config block. |
| `backend/prisma/migrations/19_llamaparse` | Provider columns on `assets`. |
| `backend/src/lib/runner.js` | Holds the generation job while extraction runs; maps terminal errors to student messages. |
| `backend/scripts/llamaparse-check.mjs` | Real API smoke check for one file. |
| `backend/scripts/llamaparse-usage.mjs` | Credit/failure report. |

## Flow

```
/complete → extractState=pending → claim (FOR UPDATE SKIP LOCKED)
  → LlamaParse enabled and format eligible?
      no  → local-first pipeline
      yes → no providerJobId: upload file, create parse job, park
            providerJobId: one status check per pass
              PENDING/RUNNING → park with providerNextPollAt backoff
              FAILED/CANCELLED → fall back to local
              COMPLETED → persist pages (+ optional OCR for empty PDF pages)
```

- A parked asset is `extractState=pending` with a `providerNextPollAt`; the
  claim SQL refuses it before that time, so status polls cannot spam the API.
- Resumption is driven by the generation job's 60 s release, the client's job
  poll, `GET /api/notes/:noteId` (note-only uploads) and the daily tick cron.
- Submitting twice is impossible: the claim lock plus a conditional update on
  `providerJobId IS NULL` make the first writer the only one.
- The whole provider deadline is `LLAMAPARSE_TIMEOUT_MS` (default 20 min). A
  timed-out job falls back to local extraction; credits already spent are kept
  in `providerCredits` when reported.
- `page_ranges.max_pages` is sent as `MAX_PAGES` (300) so the provider is not
  billed for pages the pipeline would discard anyway.
- Tables are requested as markdown; OCR languages default to English.

## Provider columns on `assets` (migration 19)

`extractProvider`, `providerFileId`, `providerJobId`, `providerStatus`,
`providerTier`, `providerCredits`, `providerPagesFailed`, `providerPolls`,
`providerAttempts`, `providerSubmittedAt`, `providerNextPollAt`,
`providerError`.

Apply with `cd backend && npx prisma migrate deploy` before running the new
server code (the generated client expects these columns).

## Environment

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `LLAMA_CLOUD_API_KEY` | — | Backend only. Never expose to Expo/Next.js. Without it the provider is skipped. |
| `LLAMAPARSE_ENABLED` | `1` | Set `0` to restore the entire pre-LlamaParse path. |
| `LLAMAPARSE_FORMATS` | `pdf,docx,pptx` | Set `docx,pptx` to keep text PDFs on the free local-first extractor. |
| `LLAMAPARSE_TIER` | `cost_effective` | Manual only; the code never upgrades a tier automatically. |
| `LLAMAPARSE_VERSION` | `latest` | Pin a dated tier version for production reproducibility when available. |
| `LLAMAPARSE_OCR_LANGUAGES` | `en` | Comma-separated. |
| `LLAMAPARSE_TIMEOUT_MS` | `1200000` | Total provider deadline before local fallback. |
| `LLAMAPARSE_MAX_ATTEMPTS` | `4` | Retryable HTTP failures (429/5xx/network) before fallback. |
| `LLAMAPARSE_UPLOAD_TIMEOUT_MS` | `120000` | Multipart upload. |
| `LLAMAPARSE_REQUEST_TIMEOUT_MS` | `30000` | Create/poll/result calls. |

## Failure and fallback policy

Terminal (asset `failed`, job error shown to the student):

- `401/403` → `LLAMA_AUTH`
- `402` → `LLAMA_QUOTA`

Fall back to the local pipeline (recorded in `providerError`, no silent loss):

- `429/5xx/network` after `LLAMAPARSE_MAX_ATTEMPTS`, or a request timeout
- `413` / other `4xx` / invalid response
- provider job `FAILED` or `CANCELLED` (no automatic resubmit — avoids double billing)
- `COMPLETED` with no usable text

A parse with some failed pages still finishes: failed pages are stored as
`SourceChunk` rows with `status=failed`, `providerPagesFailed` is recorded and
the asset is marked `truncated` so the UI shows the source is incomplete.

DOCX/PPTX use LlamaParse output only while the provider succeeds. The existing
local text + Gemini embedded-picture reading still runs when the provider falls
back, but it is not applied on top of a successful Llama parse.

## Credits

Observed cost is roughly 8 credits per page (46 pages ≈ 368 credits), so the
20,000/month allowance covers ~2,500 pages. Treat it as an estimate; actual
billing can lag and `providerCredits` may be `null` at completion.

```bash
cd backend
npm run llamaparse:usage                 # monthly totals, failures, fallbacks
npm run llamaparse:usage -- --refresh-null   # re-read credits for null rows
```

Knobs, in order of preference: `LLAMAPARSE_FORMATS` (skip PDFs), then
`LLAMAPARSE_ENABLED=0` (disable entirely). Do not lower the tier quality by
switching tiers automatically in code.

## Checks

```bash
cd backend
npm run test:llamaparse                  # offline REST client tests
npm run test:pdf                         # extraction state machine incl. provider paths
npm run test:extraction
npm run build
npm run llamaparse:check -- scripts/eval-samples/handout-30p.pdf
```

The check script may poll (it is a CLI). Request handlers must never poll: the
extraction pass performs at most one provider call before parking.

## Pre-production privacy review

Before enabling the key in production:

- Review LlamaCloud's data-retention and training policies for uploaded
  documents; record the outcome here. Document text lives with a third party for
  the duration of parsing.
- Confirm the API key is set only in the backend environment (Vercel), never in
  `Sua/` or `web/`.
- Confirm logs contain ids/status/counts only — no document text, API key or
  signed storage URL. `providerError` stores a capped provider message, not
  content.
- Decide whether to delete uploaded files from LlamaCloud after parsing (not
  implemented here; LlamaCloud retention applies).

## Known limitations

- `cost_effective` is text/table-oriented; scanned, multi-column and chart-heavy
  pages may be weaker than `agentic`.
- Diagrams/figures inside PDF/DOCX/PPTX are not described on the Llama path
  (explicit product decision). Image-only decks can yield little text.
- No webhook: completion latency is bounded by the 60 s runner release and
  client/tick polls; the Hobby cron is daily.
- The 25 MB upload cap and `.ppt` rejection are unchanged.
