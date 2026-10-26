# sumore

Sumore is a screen-time app for small groups of friends. Set daily app limits, ask your circle for extra time, and earn shared s’mores to customize your campsite and camper.

The app runs on iOS and Android. A browser preview is available for UI development; it cannot block phone apps.

## Features

- Shared or per-app daily limits, with native app selection.
- Friend circles, extra-time requests, and approvals.
- A shared campfire, s’more wallet, and character customization.
- Private account recovery keys, account deletion, and community controls.

## Quick start

Use Node 22.13 or newer and npm:

```sh
git clone https://github.com/cowcatbird/sumore.git
cd sumore/apps/mobile
npm ci
EXPO_PUBLIC_LOCAL_ART_PREVIEW=1 npm run web
```

The local browser preview uses sample data and does not contact the shared backend. To use real accounts, configure your own Supabase project and restart without the preview flag.

## Development

- [Development setup](docs/development.md): environment variables, native builds, and fork configuration.
- [Architecture](docs/architecture.md): app, native enforcement, and backend boundaries.
- [Testing](docs/testing.md): automated checks and physical-device scenarios.
- [Backend setup](supabase/README.md): database migrations, authentication, and notifications.
- [Support website](sumore-support/README.md): static privacy, support, deletion, and community pages.

```text
apps/mobile/        Expo app, native Screen Time module, and tests
supabase/           Database migrations, Edge Functions, and backend tests
sumore-support/     Static support website
docs/               Development and testing guides
```

Screen Time requires a native build and platform permissions. iOS uses Family Controls, Managed Settings, and Device Activity; Android uses Usage Access and an Accessibility service. These are voluntary controls: device owners can revoke permissions or uninstall the app.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull-request guidelines. Report security issues privately using [SECURITY.md](SECURITY.md).

## License

Sumore is available under the [MIT License](LICENSE). Third-party components retain their own licenses; see [Third party notices](THIRD_PARTY_NOTICES.md).
