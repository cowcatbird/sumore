# Contributing

Small, focused fixes and improvements are welcome. Open an issue before a large feature or a change to account, privacy, or Screen Time behavior so the approach can be discussed.

## Development workflow

1. Fork the repository and create a branch for your change.
2. Follow the [development setup](docs/development.md). Use your own backend and signing credentials.
3. Add or update tests for the behavior you change.
4. Run the checks below from `apps/mobile`.
5. Open a pull request explaining the change, testing performed, and any platform limitations. Include screenshots for visible UI changes, without private account details.

```sh
npx tsc --noEmit
npm run lint
npm test
```

For website changes, also run `node --test sumore-support/validate-site.test.mjs` from the repository root. Backend and native changes have additional checks in [Testing](docs/testing.md).

A GitHub Actions template is available in `.github/checks.yml.example`. A maintainer with workflow permission can copy it to `.github/workflows/checks.yml` to run these checks on pushes and pull requests. It has read-only permissions and does not deploy the app.

## Project conventions

- Keep changes scoped. Avoid unrelated formatting or dependency updates.
- Reuse the existing theme, components, and error-handling patterns.
- Preserve account identity checks, row-level security, permission consent, and fixed grant deadlines.
- Add a new migration for database changes; do not rewrite migrations already used by installations.
- Keep app selections and usage details on the device. Sharing app labels must remain an explicit user choice.
- Never include credentials, personal data, signing files, database dumps, or build artifacts in a pull request.

Use disposable accounts and isolated backends for tests. Do not test against another person's account or the public service. Security vulnerabilities belong in a private report, not a public issue.
