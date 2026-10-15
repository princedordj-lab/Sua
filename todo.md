# Sua — Project Specifications and Build Milestones

> **Product:** Sua (“soo-ah”), an offline-first study app for university students in Ghana and across Africa.  
> **Tagline:** Hear it once. Know it for the exam.  
> **Source of truth:** Sua Product Requirements Document (PRD) v1.0 and Sua Project Overview v1.0, October 2026, with decisions captured below.  
> **Status:** Build checklist. Check off each item when its implementation and acceptance criteria are complete.

## Product outcome

Students can record a lecture, upload learning materials, or type notes; turn them into summaries, flashcards, and quizzes; and revise daily, including offline. Sua is built around exam readiness rather than note storage alone. Android is the launch priority, with iOS supported from the shared React Native codebase.

## Decisions and unresolved items

- [x] Free plan allows **10 flashcard and quiz sets per month** (updated from the 5-set proposal in the source documents).
- [x] Semester Pass price is **GHS 150** (updated from the GHS 60 proposal). Confirm duration remains four months and validate pricing with students before launch.
- [x] Retain original audio until the student deletes it. Provide a way to delete audio and associated data; account deletion removes the student's data.
- [ ] Select and validate a secondary transcription provider for fallback.
- [ ] Determine whether lecturer or department permission is required for recording at partner campuses; provide appropriate onboarding guidance.
- [ ] Validate the AI cost target (under GHS 1.50 per free user per month) and refine limits/pricing with student research.

## Product scope and priorities

### V1 (MVP)

**P0 — required for launch:** onboarding and accounts; courses; recording, file upload, and typed notes; asynchronous AI processing; summaries, flashcards, and quizzes; offline storage and sync; spaced review; Ask Sua; Home dashboard; and GHS billing with mobile money.

**P1 — should ship:** settings and profile controls, including account, AI, data, and security settings.

**P2 — nice to have:** no additional P2 feature is defined in the source documents. Keep later roadmap work out of the V1 launch gate.

### V1.5 (after the MVP)

- **P0:** Exam Mode (countdown, adaptive daily study plan, readiness score) and Past Questions (upload, note matching, gap detection, timed mock exam and feedback).
- **P1:** Study Circles (invite up to 10 members, selectively share notes, group quiz leaderboard; private notes remain private).
- Past-question papers remain private to the student until copyright and moderation are reviewed for sharing.

### Explicitly out of scope for V1

Live collaborative editing, local-language explanations, web/desktop apps, lecturer-facing tools, and iOS-specific polish. V2/later roadmap includes live collaboration, Twi/Ga/Ewe/Hausa explanations, lecturer-verified course packs, and WASSCE/professional exam prep.

## Functional specifications

### Onboarding and account (V1 P0)

- Welcome screen and three-slide walkthrough; each slide has Skip.
- Sign in with Google, email/password, and Apple on iOS through Clerk.
- Collect university, programme, level, and optional exam date. All setup questions can be skipped and completed later.
- Create the first course automatically from setup answers.
- **Acceptance:** a new user reaches Home in under 90 seconds; no optional step blocks progress.

### Courses (V1 P0)

- Create, rename, archive, and delete courses. Course fields: name, optional code, optional exam date, colour, and archived state.
- Each note belongs to exactly one course. Courses contain notes, past questions, flashcard decks, quizzes, and progress.
- Free: up to 3 active courses. Pro: unlimited.
- Confirm before deletion and offer to move notes to another course.
- **Acceptance:** moving a note between courses takes two taps; every note has exactly one course.

### Create and capture (V1 P0)

- **Record:** pause/resume and visible timer; works offline. Save audio locally in small recoverable chunks so calls, crashes, or low battery do not lose a lecture. Compress before upload; Wi-Fi-only upload defaults on. Free: 3 recordings/month, up to 60 minutes each. Pro: unlimited recordings and no length cap.
- **Upload:** accept PDF, PowerPoint, images/photos, and plain text; extract text from scanned pages and images; max 25 MB/file in V1.
- **Type:** lightweight editor with headings, bold, bullets, and numbered lists; autosave every few seconds; works offline.
- User selects a course before creating content. Queue AI work locally while offline; notify when processing completes and show the resulting note in its course.
- **Acceptance:** recording survives app closure and is recoverable on next launch; a completed job notifies the student.

### AI processing pipeline (V1 P0)

Run work as background jobs so the student does not need to keep the app open:

1. Transcribe audio with Gemini, or extract source text from uploaded files.
2. Clean text by removing filler and correcting obvious technical terms using course context.
3. Generate a summary with **Overview, Key Points, Key Terms, Formulas/Examples (when relevant), and Likely Exam Questions**.
4. Generate 10–25 flashcards per lecture hour.
5. Generate a 5–10 question quiz with mixed multiple choice and short answer; every question has an explanation.
6. Save results, notify the student, and sync to the phone.

- Display live status: Uploading, Transcribing, Summarising, Making cards, Ready.
- Retry failed jobs automatically up to 3 times, then show a clear Try again action. If offline, queue on device until connection returns.
- Include the original transcript below each summary. Add Report a mistake to each summary, flashcard, and quiz question; save feedback with source text.
- For long lectures, split transcript into sections and combine results. Generate summary/cards/quiz in as few model calls as quality permits.
- Reject empty, too-short, or malformed output; retry once with a stricter prompt. Keep model selection configurable. Use a low-cost model for bulk generation and a stronger model for assistant/short-answer marking.
- **Acceptance / targets:** median under 8 minutes from upload to finished study set for a 30-minute recording; 98% of jobs complete without manual retry.

### Flashcards and spaced review (V1 P0)

- Generate cards automatically; allow editing, deletion, and manual creation.
- Spaced repetition ratings: Again, Hard, Good, Easy; schedule the next review accordingly.
- Home has one Daily Review action, approximately 10 minutes, mixing due cards across courses.
- Show streak; provide a gentle reminder with configurable time and off switch.
- Download decks to device. Review offline and sync progress when connected.
- **Acceptance:** complete review in airplane mode and see progress after reconnecting.

### Quizzes (V1 P0)

- Generate a quiz per note and a Course Quiz mixing questions from notes in that course.
- Support multiple choice, true/false, and short answer. Short-answer marking is AI-based and requires connectivity.
- Store quizzes on device for offline attempts. After completion show score, missed questions, and one-tap Make flashcards from my mistakes.
- **Acceptance:** downloaded quizzes run offline; short-answer grading clearly waits for connection.

### Ask Sua assistant (V1 P0)

- Chat against selected course or selected notes. Retrieve relevant passages first and ground answers in the student's content.
- Cite the source note for every note-grounded answer; tapping its citation opens that note.
- If notes do not contain the answer, say so and offer a clearly labelled general-knowledge explanation. Include quick actions: Explain simply, Give an example, Quiz me on this.
- Internet required. Free: 15 questions/month. Pro: unlimited subject to fair use.
- Never claim to be a lecturer; remind students to verify important facts against their textbook.

### Home and navigation (V1 P0)

- Five tabs: Home, Courses, Create, Study, Profile.
- Home shows today's study plan (Daily Review and due quizzes), streak, weekly progress, recent notes, Record/Upload/Type shortcuts, and free-plan usage meter.
- **Acceptance:** the next study action and current usage are easy to identify from Home.

### Billing and referrals (V1 P0)

- Plans, in GHS: Free; Pro Monthly **GHS 20**; Pro Semester Pass **GHS 150 for 4 months**; Pro Annual **GHS 150**. Semester pricing is a recorded product decision and must be validated with students before launch.
- Paystack checkout supports MTN MoMo, Telecel Cash, AirtelTigo Money, and cards.
- Provide emailed receipts, payment history in Profile, and cancellation at any time.
- Pro expiry has a 3-day grace period. Afterward restore Free limits while keeping content viewable; never delete notes because of non-payment.
- Referral codes grant one free Pro week to both referrer and referred student.
- **Limits:** Free: 10 summaries/month, 10 flashcard/quiz sets/month, 15 assistant questions/month, 3 recordings/month up to 60 minutes each, 3 active courses. Offline access included. Pro: unlimited summaries, sets, assistant use (fair use), recordings, and courses; Exam Mode and Past Questions; faster AI.

### Profile, settings, and privacy (V1 P1)

- Profile: account information/photo, plan and billing, referral code.
- AI settings: summary length (short, standard, detailed), output language (English first).
- Data settings: Wi-Fi-only uploads, auto-download decks, clear offline storage.
- Security: change password, active sessions, delete account and data.
- Keep original audio until the student deletes it. Make deletion controls clear for recordings and account data.

## V1.5 functional specifications

### Exam Mode (P0)

- Set exam date per course; show countdown on Home.
- Build a daily topic plan weighted toward low quiz scores and cards rated Again; adjust automatically after missed days.
- Readiness score per course, 0–100, based on coverage, quiz results, and card strength.

### Past Questions (P0)

- Upload past exam papers as PDF or photos. Extract questions and link each to notes that answer it; label unmatched questions as Gaps.
- Build timed Mock Exams from past questions with marking and feedback.
- Keep uploaded papers private to the student until sharing has a copyright/moderation review.

### Study Circles (P1)

- Invite classmates to a course by link or code; maximum 10 members in V1.5.
- Members see only notes explicitly shared. Private notes remain private.
- Support group quizzes and a simple leaderboard.

## Technical architecture and engineering constraints

| Concern | Specified choice / constraint |
| --- | --- |
| Mobile | React Native with Expo; Android launch priority, iOS from same codebase |
| Styling | NativeWind; use inline `className` for Views and other components; `style` only on `SafeAreaView` |
| Authentication | Clerk |
| Cloud database | NeonDB (Postgres) | Application data and sync API persistence. |
| Cloud file storage | Cloudinary | Uploaded audio, PDFs, slides, and images; asset access is mediated by the backend API. |
| ORM | Prisma | Typed database access from the backend. |
| Local-first storage | Expo SQLite; phone is primary copy, NeonDB is cloud data store, Cloudinary stores files. |
| AI generation | xKiro; configurable low-cost bulk model and stronger assistant/marking model |
| Transcription | Gemini, with secondary provider decision open |
| Payments | Paystack |
| Backend API | Express.js on Node.js; authenticated API over HTTPS connects the React Native frontend to backend services. |
| Background jobs | BullMQ + Redis |
| Product/error analytics | PostHog and Sentry |

Engineering rules:

- Every screen works without network except AI generation and Ask Sua. Offline edits sync without data loss.
- Long jobs run in background and notify on completion; never block the student.
- Compress audio, lazy-load screens, and keep downloads small.
- Every AI answer is traceable to student notes where possible.
- Use encrypted traffic, authenticated API access, protected Cloudinary assets, and Postgres row-level security so users access only their own records.
- Do not use recordings or notes to train AI models. Support deletion and comply with Ghana's Data Protection Act.
- Add monthly per-user AI caps, caching, cheap defaults, and alerts when daily AI spend crosses a configured threshold.

## Simplified data entities

- **User:** id, name, email, university, programme, level, plan, plan expiry.
- **Course:** id, user id, name, code, exam date, colour, archived.
- **Note:** id, course id, title, type (typed/recording/upload), body, transcript, summary, status.
- **Recording:** id, note id, duration, audio URL, chunk count, upload status.
- **Flashcard:** id, note id, front/back, due date, ease, interval, repetitions.
- **Quiz / QuizQuestion / QuizAttempt:** course/note association, title, question type/content/options/answer/explanation, score, answers, taken time.
- **PastQuestion (V1.5):** course, source file, text, linked note IDs.
- **ChatMessage:** user, course, role, content, source note IDs.
- **Usage:** user, month, summary count, assistant query count, recording count.
- **Payment / Referral:** provider reference, GHS amount, plan/status; referrer, referred user, reward status.

## Non-functional requirements and launch targets

- **Offline:** notes, summaries, downloaded decks, and quizzes open without network; offline edits/progress sync without data loss.
- **Performance:** Home opens in under 3 seconds on mid-range Android; lists with 500+ notes scroll smoothly.
- **Data use:** typical day under 30 MB excluding audio upload; compressed audio about 0.5 MB/minute or less.
- **Devices:** Android 8+, iOS 15+, phones with 3 GB RAM.
- **Reliability:** chunked recording persistence, crash recovery, and Recover recording on next launch.
- **Accessibility:** readable text, strong contrast, screen-reader labels on all buttons.
- **Privacy/security:** encrypted traffic, authenticated API access, protected Cloudinary assets, per-user Postgres row-level security, user-controlled deletion, no model training on student content; follow Ghana Data Protection Act.
- **90-day success measures:** 40% create first summary within 24 hours; 25% of weekly active users review 4+ days/week; 8% free-to-paid conversion; 20% day-30 retention; 98% job success; median under 8 minutes for 30-minute recording; Play Store rating 4.5+; AI cost per free user under GHS 1.50/month (validate).
- **Analytics events:** `signup_completed`, `first_recording_started`, `summary_ready`, `flashcards_opened`, `review_session_completed`, `quiz_completed`, `assistant_question_sent`, `paywall_viewed`, `checkout_started`, `payment_succeeded`, `referral_sent`, `report_mistake_tapped`, `job_failed`.

## Build milestones

Complete milestones in order where dependencies require it. Each milestone can be marked complete independently once all checklist items and its exit criteria are satisfied.

### [x] Milestone 0 — Architecture and build plan confirmed

- [x] Confirm NeonDB (Postgres) for application data, Prisma for data access, and Expo SQLite for local-first storage.
- [x] Confirm Cloudinary for cloud file storage.
- [x] Confirm Express.js on Node.js as the backend API connecting the mobile frontend to application services over HTTPS.
- [x] Record agreed product limits and pricing: 10 free flashcard/quiz sets per month and GHS 150 for the four-month Semester Pass.

**Exit criteria:** core data, file storage, and API architecture decisions are recorded and consistent across the project specifications.

### [x] Milestone 1 — App foundation, identity, and course model

- [x] Create Expo React Native app foundation, NativeWind styling conventions, navigation shell, and five-tab structure.
- [x] Implement the frontend onboarding walkthrough, setup questions, skip paths, local sign-in flow, and automatic first course. Clerk integration complete (Google + email/password; Apple sign-in deferred until the Apple Developer account is ready).
- [x] Configure NeonDB, Prisma, core schema, row-level security, and user/course ownership.
- [x] Establish authenticated Express.js API conventions and connect frontend API client to backend routes.
- [x] Configure Cloudinary file handling through the backend, including ownership checks and student deletion flows.
- [x] Implement course create, rename, archive, delete confirmation, and move-note flow.
- [] Add Sentry/PostHog foundations and analytics event definitions.(Skip) — skipped by decision; analytics move to a later milestone.

> Frontend foundation and Clerk identity are complete. NeonDB + Prisma user/course schema is live with per-user row-level security, and the authenticated Express API (`/api/me`, `/api/courses`, Clerk webhook sync) is connected to the frontend client. Cloudinary is integrated via signed direct uploads (`/api/uploads/sign`, `/api/uploads/:id/complete`, protected asset URLs at `/api/assets/:id/url`, per-asset delete, and Cloudinary cleanup on account deletion) with an RLS-protected `assets` table. Course management is complete including archive persistence across restarts, delete confirmation with local note purge, and a two-tap move-note flow (course chip in the note editor and move action on the course screen). Sentry/PostHog foundations are explicitly skipped and tracked for a later milestone.

**Exit criteria:** a new user can sign up, finish or skip onboarding, reach Home within 90 seconds, and manage courses with ownership protections in place.

### Milestone 2 — Local-first notes and capture

- [x] Implement Expo SQLite local data layer and initial cloud sync strategy.
- [x] Build typed-note editor with autosave and offline use.
- [ ] Add rich-text formatting controls and conflict resolution after the authenticated API contract is finalized.
- [ ] Build chunked offline audio recorder with pause/resume, timer, crash recovery, and recover-recording flow.
- [ ] Implement audio compression, Wi-Fi-only default, resumable background upload, and recording limits.
- [ ] Add PDF, PowerPoint, image, and text upload up to 25 MB; extract text from scans/images.
- [ ] Ensure notes and source materials are tied to exactly one course.

**Exit criteria:** create and view notes offline; record survives interruption; queued changes/uploads resume on reconnection without losing data.

#### Milestone 2 implementation plan and current slice

- [x] Add a versioned local SQLite database with WAL mode, `notes`, and durable `sync_queue` tables.
- [x] Tie every note to one `course_id`; expose course-scoped note listing and note editing routes.
- [x] Add debounced note autosave so edits remain available after leaving the editor or losing connectivity.
- [x] Surface pending-sync state in the course note list; leave queue delivery behind the authenticated Express sync contract.
- [ ] Add rich-text formatting, chunked recording/recovery, and resumable upload once Expo audio/file APIs and backend endpoints are selected and verified.
- [ ] Verify the full offline/reconnect flow on iOS and Android development builds, including crash recovery and 25 MB upload limits.

### Milestone 3 — AI processing and study-set generation

- [ ] Prototype record → transcribe → summarize on 5 real lectures; review transcript and output quality.
- [ ] Select and validate a secondary transcription provider; test on Ghanaian English accents and technical lectures.
- [ ] Implement background job queue, offline request queue, progress states, retries (up to 3), and manual retry action.
- [ ] Integrate Gemini transcription and selected fallback; implement text extraction and cleanup with course context.
- [ ] Generate structured summaries, transcript display, flashcards, and mixed quizzes with explanations.
- [ ] Handle long transcripts by sectioning and combining; validate output and retry malformed generations once.
- [ ] Persist outputs, sync them to device, notify on completion, and add Report a mistake capture with source text.
- [ ] Add configurable AI model routing, usage caps, caching, spend alerts, and cost tracking.

**Exit criteria:** the 30-minute recording median is under 8 minutes; at least 98% of jobs complete without manual retry; students can inspect transcript and results.

### Milestone 4 — Offline study loop and assistant

- [ ] Implement editable/manual flashcards and spaced-repetition scheduling (Again/Hard/Good/Easy).
- [ ] Build Daily Review across courses, streaks, weekly progress, configurable reminders, and offline progress sync.
- [ ] Build note quizzes and course quizzes; offline attempts, results, explanations, and make-cards-from-mistakes flow.
- [ ] Implement short-answer marking with clear online requirement.
- [ ] Build Ask Sua with course/note context selection, retrieval-grounded answers, note citations, general-knowledge fallback label, and quick actions.
- [ ] Add Home study plan, recent notes, create shortcuts, and free usage meter.

**Exit criteria:** a student can complete a downloaded review and quiz offline, sync progress later, and get source-linked assistant answers online.

### Milestone 5 — Plans, payments, settings, and MVP hardening

- [ ] Validate GHS 150 Semester Pass pricing with students; confirm AI usage budget and GHS 1.50 free-user monthly cost target.
- [ ] Resolve recording-permission guidance with partner campuses and add student-facing onboarding guidance.
- [ ] Implement Free and Pro entitlements and limits, including 10 sets/month and GHS 150 Semester Pass price.
- [ ] Integrate Paystack GHS checkout for MTN MoMo, Telecel Cash, AirtelTigo Money, and cards; receipts and payment history.
- [ ] Implement cancellation, 3-day grace period, limit reversion, referrals, and permanent content retention after expiry.
- [ ] Build Profile, AI/data settings, session/password controls, and account/data deletion.
- [ ] Verify privacy, RLS, storage access, data deletion, accessibility, and student-content exclusion from model training.
- [ ] Tune performance, low-data behavior, and 3 GB RAM device support; verify Android 8+ and iOS 15+.
- [ ] Validate all launch analytics, success metrics, and free-user AI cost measurement.

**Exit criteria:** core V1 P0 flows and intended P1 profile/settings are release-ready; billing works in GHS; no subscription state can make student notes inaccessible.

### Milestone 6 — Private beta and campus launch (Weeks 4–12)

- [ ] Run private beta with 30–50 students at one campus; collect daily feedback and resolve priority issues.
- [ ] Test on real Ghanaian lectures, low-end Android devices, poor connectivity, offline capture/review, and recovery cases.
- [ ] Prepare Google Play release and campus ambassador rollout across 3 departments.
- [ ] Enable payments after beta validation; monitor job success, AI spend, conversion, retention, and Play Store feedback.

**Exit criteria:** beta findings are addressed, launch checks pass, and campus rollout/operations are ready.

### Milestone 7 — V1.5 Exam Mode, Past Questions, and Study Circles

- [ ] Build per-course exam countdown, adaptive daily topic plan, readiness score, and missed-day adjustment.
- [ ] Upload past-question PDFs/photos; extract questions, link to notes, and show Gaps.
- [ ] Build timed mock exams with marking and feedback; keep papers private pending sharing review.
- [ ] Build course invite links/codes, 10-member limit, explicit note sharing, private-note protections, group quizzes, and leaderboard.
- [ ] Release Exam Mode and Past Questions ahead of the next exam period; evaluate Study Circles as V1.5 P1.

**Exit criteria:** V1.5 P0 exam preparation flows work end to end with privacy boundaries enforced; Study Circles are independently release-ready.

## Risks to track during build

- AI errors: expose transcript, mistake reporting, and fact-check guidance.
- AI cost: enforce caps, cheap default models, caching, spend alerts, and pricing validation.
- Transcription quality: use course context, allow transcript edits, and test real Ghanaian lectures.
- Recording consent: settle partner-campus guidance; typed notes and uploads remain available.
- Copyright: keep past papers private until sharing review is complete.
- Provider outages: queue/retry work, select transcription fallback, and show clear status.
- Low-end performance: test throughout on 3 GB RAM Android phones.
