# CLAUDE.md — Sumore

Sumore is a screen-time app for small groups of friends. Each person sets daily limits on the
apps they pick; when they run out they can ask their circle for extra time, and a friend
approves or denies it from a push notification. Not requesting all day earns the whole circle
a shared s'more, which buys hats, body colors, and campsite backgrounds. The product name was
"Screen Time with Friends" until September 2026; the brand is **cowcatbird**.

This file was distilled from the Codex session history (Sept 2 – Oct 27, 2026) plus the repo
docs. Read the repo docs for mechanics; read this for context, decisions, and how Lucas works.

## Working with Lucas

- Lucas is a student and self-described non-coder. Explain new concepts in plain language,
  once, when they come up. Do not lecture; do not pad.
- Keep in-app copy short and gamified. He explicitly rejected paragraph-style UI text,
  em dashes, and prompt wording leaking into the UI. Use a "?" help button for anything that
  needs explanation.
- "Local host when done" is the default expectation after UI work: start the browser preview
  on port 8082 and show a screenshot. Store screenshots must not include the status bar
  (time, Wi‑Fi, battery).
- Pushing to GitHub, TestFlight, or Android builds happens only when he asks. He often says
  "don't push yet". Builds cost Expo credits (about $2 per iPhone build, $1 per Android);
  say when a step will spend credits or money, and prefer free paths.
- He signs in to Apple, Google, Expo, and Supabase himself in a browser tab. Never type his
  passwords or codes. Apple signs him out often; ask him to sign in and say "done".
- Testers are friends: an iPhone friend on TestFlight and an Android friend who is far away and
  tests over a call. Android bugs can only be reproduced by sending him an APK.
- He draws the sprites (some AI-assisted) and pastes them in. Hat art is aligned to a white
  circle marking the head; backgrounds should be transparent; body colors should be soft.
- Public-facing text and repos must contain no AI boilerplate or "vibecoding" framing.
  He asked for the public repo to be "clean" with the messy history removed.

## Where the code lives

| Location | Role |
| --- | --- |
| `~/Documents/ChatGPT/sumore` (this repo) | Public, MIT-licensed mirror: github.com/cowcatbird/sumore. Clean history, example identifiers (`com.example.sumore`), no credentials. |
| `~/Documents/ChatGPT/screentime with friends` | Original private checkout of github.com/cowcatbird/screen-time-app. Its local git is ~74 commits behind origin (an iCloud/git issue), so do not trust its history; its working tree may be stale. |
| `~/.codex/worktrees/onboarding-polish/screentime with friends` | Where Codex actually built recent releases. Branch `codex/onboarding-polish` is pushed to origin with 3 commits not merged into `main` (Google Play bundle, Android disclosures, listing pack, Oct 24). Merge or build from that branch rather than redoing the work. |
| `~/Documents/ChatGPT/sumore-store-screenshots` | App Store / Play listing screenshots. |
| `~/Documents/ChatGPT/sumore-sprite-preview` | Scratch copy used for sprite experiments. |

Real bundle IDs, the EAS project, Apple team, Firebase file, and Supabase keys live in the
private repo and EAS, not here. Changes meant for users go to the private repo first; the
public repo is a cleaned export. Keep both in sync when exporting, and strip anything private.

## Stack and layout

- Expo SDK 57 / React Native 0.86 / React 19, Expo Router, TypeScript, Vitest, ESLint.
  Node 22.13+. Each app is its own npm package: run commands from `apps/mobile`.
- `apps/mobile/src/app` screens: Camp (`index`), `screen-time`, `requests`, `friends`
  (Circle), `customize` (Camper), `settings`, `moderation`.
- `src/domain` pure rules (shop pricing, character art, tour content, campsite layout);
  `src/features` stores (`app-store.tsx`, `character-store.tsx`, local preview);
  `src/services` backend wrappers; `src/native/screen-time.ts` bridge;
  `src/constants/theme.tsx` is the design system (read its header comment before touching colors).
- `apps/mobile/modules/screen-time`: Expo module, Swift (Family Controls, Managed Settings,
  Device Activity monitor extension) and Kotlin (Usage Access + Accessibility service).
  Config plugins in `apps/mobile/plugins` generate entitlements and extension targets.
- `supabase/`: migrations `0001`–`0034` (gaps are intentional, never renumber), Edge
  Functions `account-access`, `push-notifications`, `report-problem`, operator SQL for
  moderation review. Anonymous sign-in; RLS and authenticated RPCs; recovery keys are hashed.
- `sumore-support/public`: static support, privacy, delete-account, community pages.
  Live at sumore.cowcatbird.com (formerly sumore-support.vercel.app; the app still links the
  vercel.app privacy and deletion URLs in `src/constants/public-info.ts`).

## Commands

```sh
cd apps/mobile
npm ci
EXPO_PUBLIC_LOCAL_ART_PREVIEW=1 npm run web   # browser preview with sample data, port 8082
npx tsc --noEmit && npm run lint && npm test  # ~1,750 tests
npx expo run:ios / npx expo run:android       # native builds; Expo Go cannot block apps
npx eas-cli build --platform android --profile preview     # APK for friends
npx eas-cli build --platform android --profile production  # AAB for Play
node --test sumore-support/validate-site.test.mjs          # from repo root
```

The browser preview cannot enforce limits, send push, or hit the real backend. Enforcement,
approvals-while-closed, recovery, and deletion must be checked on physical phones with
disposable accounts. Never run tests or SQL against the production Supabase project.

## Product decisions already made (do not relitigate)

- Accounts: anonymous device accounts with a display name. Public friend codes are
  server-generated and immutable. A private login key recovers an account; entering a key on
  a new install replaces the current account. Delete account is in-app with a confirm step.
  Deleting the app does not delete server data.
- Circle: one shared group per person (same members, same wallet). No circle leader.
  Anyone can leave or block. Nobody approves their own request.
- S'mores: shared wallet; the circle earns 1 s'more per day only if nobody requested extra
  time. New circles start at 0. Prices: free hats, premium hats 5, crown 10, body colors 5,
  backgrounds (beach, snow) 30. Unlocks are shared by the circle.
- Screen time: limits are per person, never shared. Shared-or-per-app daily limits, a
  "selected apps" icon grid, a total time-left bar, preset extra-time buttons plus Custom.
  An approval grants time immediately with no second confirmation. Panic button spends
  s'mores and never goes negative.
- Marshmallow burns only when someone requests more time (the point is not wanting to).
- Onboarding: a short swipeable tour (no skip), ending with a slide about the login key.
  Settings has Account (login key, already have an account, delete) above Help & feedback
  (app tour, report a problem). Report a problem opens a prefilled email to
  cowcatbird.dev@gmail.com; moderation reports are reviewed in the Supabase dashboard.
- Theme follows the system light/dark setting. App icon is the charcoal variant.

## Release state (as of Oct 27, 2026)

- iOS: **Sumore 1.2.0 (build 37) is live, free, US only, 13+**, App Store id 6811461202,
  released Oct 22 after two rejections (a Screen Time entitlement check Apple got wrong, then
  permission-prompt wording; "Allow Screen Time" became "Continue" and declining must not
  error or re-prompt). 1.2.1 (welcome screen redesign, fluid tour swiping) was submitted
  Oct 24; check App Store Connect for its status before assuming it shipped.
- Android: testing APKs are attached to GitHub releases on the private repo
  (latest 1.2.1 build 28/29). A signed AAB and Play listing pack were prepared on the
  `codex/onboarding-polish` worktree. Google Play account verification was in progress
  Oct 26–27. Still needed: real-phone confirmation that blocking works while an app is
  already open, Android screenshots, the Accessibility declaration + demo video, Data Safety
  form, and a 14-day closed test with 12 opted-in testers before production access.
- Apple shows the seller as Lucas's legal name; publishing as "cowcatbird" needs a registered
  business, which he has not set up. Use "Made by cowcatbird" in-app and on the site instead.
- Expo account is the `cowcatbird` organization; Apple developer and Google Play accounts use
  cowcatbird.dev@gmail.com. Vercel team: cowcatbird. Socials: GitHub org cowcatbird,
  X @cowcatbirddev, Instagram @cowcatbird.

## Known gotchas

- Android blocking has regressed twice to "only blocks after the app is closed and
  reopened"; the fix watches foreground/window events including keyboard and notification
  windows. Any change to the Accessibility service needs the Android friend to retest with a
  one-minute limit, including after opening notifications.
- iOS Family Controls selection once "disappeared" seconds after picking apps, and the
  Screen Time tab once crashed on open; applying a restriction used to take 15–20 s. Test
  the Screen Time tab on a real iPhone after touching the native module or its store.
- Keyboard covering text inputs was a recurring complaint; use the existing
  `keyboard-form.tsx` pattern for any new form.
- Hat sprites with white fringes or wrong alignment come from the PNG, not the code.
- Changing native code, plugins, or entitlements needs a new EAS build; a JS update cannot
  add them, and OTA updates are off by default.
