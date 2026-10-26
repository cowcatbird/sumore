# Mobile app

Sumore uses Expo SDK 57, React Native, and Expo Router. The TypeScript app lives in `src/`; the local Screen Time module implements Swift and Kotlin enforcement.

## Run locally

Use Node 22.13 or newer and npm. From this directory:

```sh
npm ci
cp .env.example .env.local
npm run web
```

Set your own Supabase URL and publishable key in `.env.local` for connected accounts. Follow the [backend setup](../../supabase/README.md) first. Missing configuration displays a setup message; it does not create a remote account.

For a self-contained browser preview without a backend:

```sh
EXPO_PUBLIC_LOCAL_ART_PREVIEW=1 npm run web
```

This development-only provider uses local sample accounts and does not authenticate with Supabase, send notifications, or change remote data. Restart without the flag to use connected accounts. It is unavailable in release builds.

## Native development

Expo Go and browsers cannot restrict other apps. Build and install the native app before testing Screen Time:

```sh
npx expo run:android
# On macOS with Xcode:
npx expo run:ios
```

Use your own app identifiers and signing configuration; see [development setup](../../docs/development.md). iOS Screen Time also needs Family Controls entitlements, an App Group, and a provisioned monitor extension. Android needs user consent, Usage Access, and the Accessibility service. See the [native module](modules/screen-time/README.md) for platform details.

Once a development build is installed, start its JavaScript server with:

```sh
npm run start:dev-client
```

Changing native code, config plugins, or entitlements requires another native build. A JavaScript update cannot add native capabilities.

## Checks

```sh
npx tsc --noEmit
npm run lint
npm test
```

Tests cover application logic, UI behavior, configuration, and native source contracts. Run native unit tests and the [device checklist](../../docs/testing.md) for changes to app restrictions.
