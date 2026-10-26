# Native Screen Time module

This Expo module implements device-local app selection, daily limits, and approved temporary access on iOS and Android. It requires a native build; Expo Go and the web implementation cannot restrict other apps.

## Platforms

| Platform | Enforcement | Requirements |
| --- | --- | --- |
| iOS | Family Controls selection, Managed Settings shields, and Device Activity monitoring | User authorization, Family Controls entitlements, shared App Group, monitor extension |
| Android | Usage measurement and Accessibility-based blocking | Affirmative disclosure consent, Usage Access, enabled Accessibility service |
| Web | Unavailable status | UI development only |

Device owners can revoke authorization or uninstall the app. Neither platform is an unbreakable parental-control boundary.

## iOS configuration

The `with-screen-time` config plugin creates the monitor extension and shared capabilities when `SUMORE_SCREEN_TIME_ENABLED=true`. Configure your own bundle identifier, Apple team, and App Group. Both the main app and monitor need matching provisioning; distribution approval is separate from merely setting the build flag.

The optional `SUMORE_SCREEN_TIME_REPORTS_ENABLED=true` flag adds a report extension. The report target needs its own provisioning, and the app checks OS and extension availability before exposing reports. Do not equate an unavailable remaining-time display with a disabled limit.

App selections are opaque tokens kept in the App Group. Cross-process locking coordinates app and monitor state. A fresh native build is required when changing extensions, capabilities, or native code.

## Android configuration

The `with-screen-time-android` plugin includes the native service configuration. Consent, Usage Access, Accessibility state, and daily-limit state are separate checks. The service uses an Accessibility overlay; it does not require the general draw-over-other-apps permission.

Selection, allocation, and usage state stay on the device. The service observes foreground-app events and checks limits while an app remains open. Test this on physical devices, including manufacturer-specific background restrictions.

## Bridge

The TypeScript interface in `src/ScreenTimeModule.ts` exposes:

- `setAccount`: bind state to the current account and clear stale account data when it changes.
- `getStatus`: return availability, permission, selection, limit, and grant state.
- `requestAuthorization`, permission-setting methods, and `setDisclosureAccepted`: manage the platform permission flow.
- `presentAppPicker` and `presentAppLimits`: select apps and configure individual allocations.
- `configureDailyLimit` and `setBlockingEnabled`: configure the daily policy and enable restrictions.
- `requestDisable`, `cancelDisable`, and `clearSelection`: manage changes and reset local selections.
- `grantTemporaryAccess`: apply a validated, account-bound server receipt.

Status fields describe the engine's state; they do not independently prove that another app's screen is blocked. Keep platform-specific UI behind capability checks.

## Temporary access

The server receipt includes `grantId`, `requesterId`, `requestId`, `startedAt`, `expiresAt`, and `serverNow`. The client must obtain it from the authenticated backend and confirm the active account before calling native code.

Native validation rejects invalid identities, dates, expired grants, and replayed grants. Retrying the same receipt preserves its original deadline. Operating-system scheduling is not an exact-second timer, so test expiration with the app closed, the device locked, and after a restart.

See [Testing](../../../../docs/testing.md) for unit tests and the physical-device checklist.
