# Sua Web

The online-first web app for [Sua](../README.md): courses, notes, uploads, AI generation, daily review, decks, quizzes, Ask Sua and account settings — sharing the same Clerk users, Neon Postgres data and Express AI pipeline as the mobile app.

Built with **Next.js 16.4** (App Router, React 19, Tailwind CSS v4, Turbopack) and TypeScript. The build plan and milestone log live in [`../buildstep.md`](../buildstep.md).

## Run it

```bash
cd web
cp .env.example .env.local     # then fill in the Clerk keys
npm install
npm run dev                    # http://localhost:3000
```

The web app talks to the existing API in `backend/`, so start that first:

```bash
cd backend
npm run dev                    # API on :4000
npm run worker                 # BullMQ worker — AI jobs never finish without this
```

`NEXT_PUBLIC_API_URL` defaults to `http://localhost:4000/api`. `npm run dev` on the API is enough for everything except AI generation (summaries, cards, quizzes, short-answer marking), which needs Redis + the worker and the generation keys described in the root `AGENTS.md`.

### Env

| Key | Notes |
| :--- | :--- |
| `NEXT_PUBLIC_API_URL` | Express base URL, no trailing slash. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Must be the **same Clerk instance as mobile**, or accounts (and therefore data) will not be shared. |
| `CLERK_SECRET_KEY` | Server-only (proxy/route handlers). Never expose it in client code. |

Nothing else is required: uploads are signed by the backend (Neon Object Storage, with Cloudinary as its backend-side fallback), so the browser never holds a storage secret.

## Scripts

```bash
npm run dev     # next dev (Turbopack)
npm run build   # next build — includes the TS pass
npm start       # serve the production build
npm run lint    # eslint-config-next
```

There is no test suite; verification is `npx tsc --noEmit` + `npx eslint .` + `npm run build`.

## Structure

```
web/
  app/
    page.tsx                 marketing landing (client CTA island)
    download/page.tsx        public Android install page (APK url/size/hash in config/download.ts)
    health/page.tsx          GET /api/health status page
    sign-in|sign-up/…        Clerk <SignIn/> / <SignUp/> (+ Suspense)
    onboarding/              first-run university / programme / level → first course
    app/                     the signed-in product (URLs read /app/…)
      layout.tsx             AppDataProvider + AppShell
      home, courses, courses/[id], note/[id], jobs/[noteId],
      create, study, review, deck/[id], quiz/[id],
      ask-sua, profile, preferences
    app.css                  every app-screen style (tokens live in globals.css)
  components/                app shell, data provider, ui primitives, markdown, report-mistake
  config/                    theme.ts (ported palette) + appearance.tsx (mode provider) + download.ts (Android release asset)
  lib/
    api.ts                   typed fetch client + ApiError
    use-api.ts               Clerk-token-bound wrapper around api.ts
    use-resource.ts          fetch-on-mount + reload/retry hook
    types.ts                 shared + Server* response types
    prefs.ts                 localStorage preferences (session length, text size, …)
    srs.ts                   SM-4 lite scheduling, identical to mobile/backend
    generation.ts            generation-kind mapping + pipeline stage copy
    uploads.ts               validate → sign → direct PUT → complete
    markdown.ts              markdown subset helpers (toolbar + parser)
  proxy.ts                   Clerk middleware (Next 16 renamed middleware → proxy)
```

### Notes for contributors

- **Cache Components is on.** Any client hook that reads URL data (`usePathname`, `useParams`, `useSearchParams`) needs a `<Suspense>` boundary above it, otherwise dynamic-param routes fail to prerender with `blocking-prerender-client-hook`. `components/app-shell.tsx` and the `[id]` routes show the pattern.
- **Clerk Core 3 (v7).** `<SignedIn>`, `<SignedOut>` and `<Protect>` throw in client components; use `useAuth()`.
- **Next 16 renamed `middleware.ts` to `proxy.ts`** and route layouts use the generated `LayoutProps<"/path">` types.
- **Styling.** Tailwind utilities where convenient, plus `.class` names in `app/app.css` for screens. Colors come from `config/theme.ts` / CSS variables — no hex literals in components. Gold is fill-only, one gold button per screen, 48 px minimum tap targets.
- **Data rules.** Every request goes through the same `withUser`-guarded backend routes as mobile; the web never talks to Postgres directly. Client ids for notes come from `crypto.randomUUID()` (the backend accepts client-supplied ids on `/notes/sync`), and `POST /jobs` needs the note to exist first.
- **Additive backend routes** used only by the web: `GET /api/study/home-summary`, `GET /api/study/sets`, `GET /api/study/due` (with `ahead=N` for the review-ahead fallback), `GET /api/study/quizzes/:quizId`, `GET /api/notes/:noteId`. Keep them additive; mobile is not expected to call them.

## Deploy

1. `vercel link` inside `web/` (project root = `web/`), framework preset Next.js.
2. Set `NEXT_PUBLIC_API_URL` to the deployed API, plus the Clerk publishable/secret keys for the production instance.
3. In `backend/`: allow the web origin with `CORS_ORIGIN`, and add the web domain to the Clerk instance's allowed origins / sign-in URLs.
4. Preview deployments work per PR — remember each preview origin needs CORS + Clerk allowlisting (or a wildcard in a non-production environment).

The AI worker cannot run on Vercel: it needs the long-running host with Redis described in the root `AGENTS.md`.

## Known gaps

- **Online-only by design.** No offline queue, IndexedDB cache or background sync; the mobile app remains the offline path.
- **No billing UI.** Free-plan limits are shown read-only from `GET /api/me` usage and surfaced as backend 403s.
- **Summary length** is stored as a preference but the pipeline still writes its standard depth (the screen says so).
- **Quiz attempt history** ("best score" per quiz) is mobile-local today; the web shows each quiz's question count and the latest attempt on the quiz screen instead.
- **Live AI verification** requires the worker + Redis + generation keys; without them jobs stay `queued` and the UI shows that state rather than failing.
