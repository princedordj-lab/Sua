# Sua

Sua is an offline-first study companion for university students. The app turns lectures, slides, and typed notes into focused study material such as summaries, flashcards, and quizzes.

This repository is a monorepo containing the React Native frontend and the backend workspace.

## Repository layout

```text
Sua/
├── Sua/       # Expo React Native frontend
├── backend/   # Backend workspace
├── design_tokens/
├── images/
├── todo.md
└── Sua — Project Overview.md
```

## Frontend setup

The frontend uses Expo SDK 57, Expo Router, React Native, TypeScript, and NativeWind.

```bash
cd Sua
npm install
npm start
```

Useful commands:

```bash
npm run android
npm run ios
npm run web
npx tsc --noEmit
npx expo lint
npx expo-doctor
```

## Current app flow

```text
Welcome → Onboarding → Sign in → Setup → Home
                                      ↓
                 Home · Courses · Create · Study · Profile
```

The frontend includes onboarding and setup, authenticated route guards, the five-tab navigation shell, and local course management. Session and course state are currently local while backend integration is being built.

## Frontend conventions

- Routes live in `Sua/src/app` and use Expo Router.
- Shared components live outside the route directory.
- Use `className` with NativeWind for component styling.
- Use `SafeAreaView` from `react-native-safe-area-context`.
- Design tokens live in `Sua/src/config/theme.ts` and are mirrored in `Sua/tailwind.config.js`.
- Keep the frontend usable offline wherever the feature allows it.

## Backend

The `backend/` directory is reserved for the authenticated Express API, database access, Cloudinary file handling, and background jobs described in the project specifications. It currently contains a placeholder so the workspace is versioned before backend implementation begins.

## Product documentation

- [Project overview](<Sua — Project Overview.md>)
- [Product requirements](<Sua — Product Requirements Document (PRD).md>)
- [Build milestones](todo.md)
