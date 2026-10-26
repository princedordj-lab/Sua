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
│   │   ├── app/        # Expo Router routes
│   │   ├── components/ # Shared UI components
│   │   ├── lib/        # API clients, utilities, types
│   │   └── state/      # Global state (Context API)
│   ├── assets/         # Images and static resources
│   └── package.json
├── backend/            # Node.js Express API
│   ├── src/
│   │   ├── routes/     # API endpoints
│   │   ├── middleware/ # Auth and error handling
│   │   ├── lib/        # DB and utility functions
│   │   └── generated/  # Prisma client
│   ├── prisma/         # Database schema and migrations
│   └── package.json
├── web/                # Next.js 16 web app (landing, /health, signed-in app under /app)
│   ├── app/            # App Router routes + app.css
│   ├── components/     # App shell, data provider, UI primitives
│   ├── lib/            # API client, prefs, SRS, markdown, uploads
│   └── package.json
├── design_tokens/      # Tailwind config and shared theme
└── images/             # Marketing and screenshot assets
```

> The web app is documented in [`buildstep.md`](buildstep.md) (plan + milestone log) and [`web/README.md`](web/README.md) (structure, run, deploy). It is online-first and shares the same Clerk users, Neon data and AI pipeline as mobile.

---

## 3. Tech Stack

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Mobile** | React Native (Expo SDK 57) | Cross-platform mobile app |
| **Routing** | Expo Router | File-based navigation |
| **Styling** | NativeWind (Tailwind CSS) | Inline `className` styling |
| **Local DB** | Expo SQLite | Offline-first data storage |
| **Backend** | Node.js + Express.js | Authenticated REST API |
| **Cloud DB** | NeonDB (PostgreSQL) | Persistent user data |
| **ORM** | Prisma | Type-safe database access |
| **Auth** | Clerk | User management and sessions |
| **AI** | OpenRouter / Gemini | Summaries, flashcards, transcription |
| **Files** | Cloudinary | Audio and document storage |
| **Payments** | Paystack | Mobile Money (MoMo) and cards |
| **Jobs** | BullMQ + Redis | Background processing queue |

---

## 4. Engineering Rules & Conventions

### Frontend (React Native)
1.  **Styling:** Always use NativeWind `className` for styling views and components. Use the `style` prop **only** on `SafeAreaView`.
2.  **Offline First:** Every screen must function without network access, except for AI generation and the Assistant. Queue mutations and sync when online.
3.  **Paths:** Routes live in `Sua/src/app`. Shared components live in `Sua/src/components`.
4.  **Theme:** Use design tokens from `Sua/src/config/theme.ts`. Do not hardcode colors.

### Backend (Node.js)
1.  **API Security:** All routes must be protected by Clerk authentication middleware unless explicitly public (e.g., webhooks).
2.  **Database:** Use Prisma for all DB interactions. Ensure Row Level Security (RLS) policies prevent users from accessing others' data.
3.  **File Handling:** Never expose Cloudinary secrets to the client. Uploads must be mediated by the backend API.
4.  **Jobs:** Long-running tasks (transcription, AI summarization) must be offloaded to BullMQ workers.

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
-   **Note:** The core content unit (transcript, summary, flashcards).
-   **Flashcard:** Spaced repetition data (due date, ease factor).
-   **Quiz:** Questions and attempt history.

---

## 6. Build Milestones

### V1 (MVP) - Current Focus
-   [x] Onboarding & Authentication (Clerk)
-   [x] Course Management (CRUD)
-   [x] Content Creation (Record, Upload, Type)
-   [x] AI Pipeline (Transcribe → Summary → Flashcards → Quiz)
-   [x] Offline Sync (SQLite ↔ Postgres)
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
npm run android    # Run on Android emulator/device
npm run ios        # Run on iOS simulator
npx expo lint      # Check for linting errors
npx tsc --noEmit   # Type check
```

### Backend (`cd backend`)
```bash
npm run dev        # Start dev server with watch mode
npm run worker     # BullMQ worker — needed for AI jobs
npm run prisma     # Run Prisma CLI commands
npx prisma migrate dev  # Apply DB migrations
npx prisma generate   # Regenerate Prisma client
```

### Web (`cd web`)
```bash
npm run dev        # Next.js dev server on http://localhost:3000
npm run build      # Production build (includes typecheck)
npm run lint       # eslint
npx tsc --noEmit   # Type check
```

---

## 8. References
-   [Project Overview](./Sua%20—%20Project%20Overview.md)
-   [Product Requirements (PRD)](./Sua%20—%20Product%20Requirements%20Document%20(PRD).md)
-   [Build Checklist](./todo.md)
-   [Web build plan](./buildstep.md) · [Web app notes](./web/README.md)
