# Sua — Agent Instructions

**Product:** Sua ("soo-ah"), an offline-first study app for African university students.  
**Tagline:** Hear it once. Know it for the exam.  
**Repository Root:** `d:\Sua`

---

## 1. Project Overview

Sua is a mobile study companion that turns lectures, slides, and typed notes into summaries, flashcards, and quizzes. It is built around **exam readiness** rather than simple note storage. The app works offline for all core study features, syncing to the cloud when connectivity is available.

### Key Differentiators
- **Offline-First:** Notes, flashcards, and quizzes work without internet. AI generation queues until online.
- **Exam Focus:** Includes Exam Mode (countdown, daily plans) and Past Questions integration.
- **Africa-First Design:** Optimized for low-data environments, mobile money payments (GHS), and Ghanaian university contexts.

---

## 2. Repository Structure

This is a monorepo containing the frontend and backend workspaces.

```text
Sua/
├── Sua/                # Expo React Native Frontend (Android/iOS)
│   ├── src/
│   │   ├── app/        # Expo Router routes (create.tsx = record/type/upload)
│   │   ├── components/ # Shared UI components (markdown.tsx renderer)
│   │   ├── lib/        # API clients, utilities, types
│   │   │   ├── notes.ts    # SQLite local data layer (versioned migrations, sync/recordings/uploads)
│   │   │   ├── uploads.ts  # Cloudinary upload queue flusher
│   │   │   └── markdown.ts # Markdown toolbar transforms
│   │   └── state/      # Global state (Context API, offline hydration)
│   ├── assets/         # Images and static resources
│   └── package.json
├── backend/            # Node.js Express API
│   ├── src/
│   │   ├── routes/     # API endpoints (notes sync, uploads sign/complete)
│   │   ├── middleware/ # Auth and error handling
│   │   ├── lib/        # DB, user, identity, and extract.js (PDF/DOCX/PPTX/TXT)
│   │   └── generated/  # Prisma client
│   ├── prisma/         # Schema + numbered migrations (0_… through 4_…)
│   └── package.json
├── design_tokens/      # Tailwind config and shared theme
└── images/             # Marketing and screenshot assets
```

---

## 3. Tech Stack

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Mobile** | React Native (Expo SDK 57) | Cross-platform mobile app |
| **Routing** | Expo Router | File-based navigation |
| **Styling** | NativeWind (Tailwind CSS) | Inline `className` styling |
| **Local DB** | Expo SQLite | Offline-first data storage (versioned via `PRAGMA user_version`) |
| **Audio** | expo-audio | Chunked lecture recording (pause/resume, 2-min m4a segments) |
| **Network** | @react-native-community/netinfo | Connectivity-aware sync and upload triggers |
| **Pickers** | expo-document-picker / expo-image-picker | PDF and image capture for uploads |
| **Backend** | Node.js + Express.js | Authenticated REST API |
| **Cloud DB** | NeonDB (PostgreSQL) | Persistent user data |
| **ORM** | Prisma | Type-safe database access |
| **Auth** | Clerk | User management and sessions |
| **AI** | OpenRouter / Gemini | Summaries, flashcards, transcription |
| **Files** | Cloudinary | Audio and document storage (restricted, signed URLs) |
| **Extraction** | pdf-parse + jszip (pure JS) | Server-side PDF/DOCX/PPTX/TXT text extraction |
| **Payments** | Paystack | Mobile Money (MoMo) and cards |
| **Jobs** | BullMQ + Redis | Background processing queue |

---

## 4. Engineering Rules & Conventions

### Frontend (React Native)
1.  **Styling:** Always use NativeWind `className` for styling views and components. Use the `style` prop **only** on `SafeAreaView`.
2.  **Offline First:** Every screen must function without network access, except for AI generation and the Assistant. Queue mutations and sync when online.
3.  **Paths:** Routes live in `Sua/src/app`. Shared components live in `Sua/src/components`.
4.  **Theme:** Use design tokens from `Sua/src/config/theme.ts`. Do not hardcode colors.
5.  **Local DB:** Schema changes are additive migrations in `Sua/src/lib/notes.ts` versioned with `PRAGMA user_version`. Never edit a migration that has shipped — append a new version.
6.  **Sync conflicts:** The client pushes `updatedAt`; the server rejects stale writes with a timestamp guard and pulls use pending-safe upserts (a local pending row is never clobbered by server data).
7.  **Recording:** Audio is recorded as 2-minute m4a segments with a unique file name per segment; only `finalized` segments are uploadable. On crash recovery, drop the in-progress segment (m4a moov is written at stop, so truncated files are unplayable) and keep finalized ones as the resume base. Never hand-edit `android/`/`ios/` — regenerate with `npx expo prebuild` (e.g., for RECORD_AUDIO permission via the expo-audio plugin).
8.  **Markdown:** Use the in-house renderer (`Sua/src/components/markdown.tsx` + `Sua/src/lib/markdown.ts`). No third-party markdown libraries (React 19 compatibility).
9.  **Upload queue:** Save the local note first, then enqueue; drain in order — note sync before uploads (uploads may reference a note still in the push queue). Respect the persisted Wi-Fi-only toggle.

### Backend (Node.js)
1.  **API Security:** All routes must be protected by Clerk authentication middleware unless explicitly public (e.g., webhooks).
2.  **Database:** Use Prisma for all DB interactions. Ensure Row Level Security (RLS) policies prevent users from accessing others' data.
3.  **Migrations:** Name migrations with the running-number convention (`0_init`, `1_rls`, … next is `5_…`). Never timestamped names — Prisma replays directories lexicographically, and a `20261015_…` name sorts before `2_notes`/`3_assets`, breaking shadow-database replay.
4.  **File Handling:** Never expose Cloudinary secrets to the client. Uploads follow sign → direct multipart to Cloudinary → complete. `/sign` validates kind/format and noteId ownership (a noteId that has not synced yet is allowed — its upload can race the note push — but a found note owned by another user is rejected); `/complete` verifies the remote asset before activation.
5.  **Text extraction:** Pure JS only (`Sua/backend/src/lib/extract.js`: pdf-parse for PDF, JSZip for DOCX/PPTX, plain UTF-8 for TXT), runs inline at `/complete` for documents ≤ 25 MB, capped at 100k chars, and stores `Asset.extractedText`. Extraction failures return `null` — an upload must never fail because a file was unparseable. Audio transcription and image OCR belong to the AI pipeline (BullMQ, Milestone 3), not here.
6.  **Jobs:** Long-running tasks (transcription, AI summarization) must be offloaded to BullMQ workers.

### General
-   **Type Safety:** Prefer TypeScript. Ensure Prisma client types are used consistently.
-   **Error Handling:** Gracefully handle network failures. Show clear "Retry" states for failed background jobs.
-   **Privacy:** Do not use student recordings or notes to train AI models. Support full data deletion.

---

## 5. Core Features & Flow

### User Journey
`Welcome → Onboarding → Sign In → Setup (University/Courses) → Home`

### Navigation Tabs
1.  **Home:** Daily study plan, streak, recent notes, quick actions.
2.  **Courses:** List of courses containing notes, decks, and quizzes.
3.  **Create:** Record audio, upload PDFs/slides, or type notes.
4.  **Study:** Flashcard reviews, quizzes, and Ask Sua assistant.
5.  **Profile:** Account settings, billing, and preferences.

### Data Model (Simplified)
-   **User:** Profile, plan status (Free/Pro), university info.
-   **Course:** Container for notes, exams, and progress.
-   **Note:** The core content unit — title, markdown `body`, `transcript`, `sourceType` (typed/audio/document/image), `updatedAt` sync guard; always tied to exactly one course.
-   **Asset:** Cloudinary upload record — kind (audio/image/document), signed `publicId`, bytes, format, `status` (pending/active), `noteId`, server-side `extractedText` for documents.
-   **Flashcard:** Spaced repetition data (due date, ease factor).
-   **Quiz:** Questions and attempt history.

Local-only (SQLite, not synced as tables): recording sessions/segments, upload queue with attempt counts, pending sync metadata on notes/courses.

---

## 6. Build Milestones

### V1 (MVP) - Current Focus
-   [x] Onboarding & Authentication (Clerk)
-   [x] Course Management (CRUD)
-   [x] Content Creation (Record, Upload, Type)
-   [x] AI Pipeline (Transcribe → Summary → Flashcards → Quiz) — Milestone 3
-   [x] Offline Sync (SQLite ↔ Postgres, conflict guard + pending-safe pulls)
-   [x] Local-First Capture (chunked recorder with crash recovery, 25 MB uploads with server-side text extraction, markdown editor) — Milestone 2
-   [ ] Billing (Paystack Integration)
-   [ ] Ask Sua Assistant

### V1.5 (Post-Launch)
-   **Exam Mode:** Countdown timers and adaptive study plans.
-   **Past Questions:** Upload past papers and link to notes.
-   **Study Circles:** Collaborative groups and shared decks.

---

## 7. Useful Commands

### Frontend (`cd Sua`)
```bash
npm start          # Start Expo dev server
npm run android    # Build & run native Android dev build (expo run:android)
npm run ios        # Build & run native iOS dev build (expo run:ios)
npx expo prebuild  # Regenerate android/ and ios/ after app.json plugin changes
npx expo lint      # Check for linting errors
npx tsc --noEmit   # Type check
```

### Backend (`cd backend`)
```bash
npm run dev        # Start dev server with watch mode
npm run prisma     # Run Prisma CLI commands
npx prisma migrate dev  # Apply DB migrations (also regenerates the client)
npx prisma generate   # Regenerate Prisma client
```

---

## 8. References
-   [Project Overview](./Sua%20—%20Project%20Overview.md)
-   [Product Requirements (PRD)](./Sua%20—%20Product%20Requirements%20Document%20(PRD).md)
-   [Build Checklist](./todo.md)
