# Sua frontend

The Sua frontend is an Expo React Native application for offline-first study support. It uses Expo Router for navigation, NativeWind for styling, and TypeScript for application code.

## Requirements

- Node.js
- npm
- Android Studio or an iOS simulator for native development, or Expo web for browser testing

## Install and run

```bash
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

## Navigation flow

New users move through:

```text
Welcome → Onboarding → Sign in → Setup → Home
```

After setup, the authenticated app provides five tabs:

```text
Home · Courses · Create · Study · Profile
```

Setup creates the user's first course and redirects to `/home`. The current session and course state are local while the backend integration is being built.

## Source structure

```text
src/
├── app/              # Expo Router screens and layouts
├── components/       # Shared UI components
├── config/theme.ts   # Design tokens and reusable UI classes
├── lib/              # API client and shared types
└── state/            # App session and course state
```

## Styling rules

- Use NativeWind `className` values for component styling.
- Use `SafeAreaView` from `react-native-safe-area-context`.
- Keep screens readable and multiline; run Prettier after structural changes.
- Use the tokens in `src/config/theme.ts` instead of introducing new colour or spacing values.

## Notes

The frontend is part of the repository root monorepo. The backend workspace is located at `../backend`.
