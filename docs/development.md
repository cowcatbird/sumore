# Development setup

Use Node 22.13 or newer and npm. The mobile app is an independent package in `apps/mobile`; install its dependencies with `npm ci`.

## Browser preview

From `apps/mobile`:

```sh
EXPO_PUBLIC_LOCAL_ART_PREVIEW=1 npm run web
```

The preview uses local sample data without remote authentication, notifications, or database writes. It is for layout and interaction work, not enforcement testing. Restart Expo without the flag to use connected accounts.

## Connected accounts

Set up your own [Supabase backend](../supabase/README.md), copy `apps/mobile/.env.example` to `.env.local`, and provide:

```dotenv
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

These values are bundled into the app. Never use a service-role or secret key here. Use a separate development backend, not the public Sumore service.

## App identity

The checked-in defaults use `com.example.sumore`. Before distributing a fork, assign identifiers you control in `apps/mobile/.env.local` or your build environment:

| Variable | Purpose |
| --- | --- |
| `SUMORE_ANDROID_PACKAGE` | Android application ID |
| `SUMORE_IOS_BUNDLE_IDENTIFIER` | iOS application ID |
| `SUMORE_APP_SCHEME` | Deep-link scheme |
| `SUMORE_APP_SLUG` | Expo project slug |
| `SUMORE_EXPO_OWNER` | Your Expo account or organization |
| `SUMORE_EAS_PROJECT_ID` | Your EAS project UUID |
| `SUMORE_IOS_APPLE_TEAM_ID` | Your Apple signing team |
| `SUMORE_IOS_APP_GROUP` | Shared app/extension group; defaults to `group.<bundle identifier>` |

Review the resolved configuration with `npx expo config --type public`. Configure matching Auth redirect URLs in your backend when changing the scheme. Also review support addresses, website links, privacy disclosures, app branding, and store submission settings for your deployment.

## Android

Install Android Studio, the SDK required by the project, and a compatible JDK. Then run:

```sh
npx expo run:android
```

The app can build for local development without push configuration. To test remote notifications, register your Android package in your own Firebase project and set `SUMORE_ANDROID_GOOGLE_SERVICES_FILE` to its downloaded `google-services.json`. The Firebase client file is not a service-account key; keep service-account credentials private and configure them through your push provider.

The EAS preview and production profiles require Firebase configuration. `SUMORE_ANDROID_PUSH_REQUIRED=true` enables the same validation explicitly. Test Usage Access, Accessibility consent, blocking while a selected app is already open, and notifications on a physical device.

## iOS

Use macOS, Xcode, and your own Apple signing configuration:

```sh
npx expo run:ios
```

Screen Time is disabled by default. Set `SUMORE_SCREEN_TIME_ENABLED=true` only after configuring Family Controls and the shared App Group for your app and monitor extension. Distribution requires the appropriate Apple approval and provisioning for each enabled target. `SUMORE_SCREEN_TIME_REPORTS_ENABLED=true` adds the optional report extension and its separate provisioning requirements.

The simulator is useful for UI and compilation checks. It does not replace physical-device authorization and restriction tests.

## Builds and updates

Use the standard Expo native build workflow or your own EAS project. From `apps/mobile`, the EAS `preview` profile produces an Android APK and `production` produces the store build:

```sh
npx eas-cli build --platform android --profile preview
npx eas-cli build --platform android --profile production
```

Cloud builds may consume your provider's credits. Configure your own signing credentials and store application IDs before submitting a build. This repository contains no store credentials or upload destinations.

Over-the-air updates are disabled by default. To use them, set your own EAS project UUID and `SUMORE_EAS_UPDATES_ENABLED=true`. Keep runtime versions compatible with the native binary; updates cannot add native modules, permissions, or extensions.
