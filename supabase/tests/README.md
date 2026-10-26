# Backend tests

Backend tests cover authorization, account recovery, fixed grant deadlines, shared purchases, membership changes, and moderation. Use disposable databases and accounts. Never run mutation or smoke-test scripts against a service containing real users.

## In-memory PostgreSQL

The `run-*.mjs` PGlite runners create isolated databases in memory. They do not read project credentials or connect to Supabase. Install the test dependency outside the mobile package:

```sh
sumore_test_deps=$(mktemp -d)
npm install --prefix "$sumore_test_deps" @electric-sql/pglite
node supabase/tests/run-screen-time-grants.mjs "$sumore_test_deps/node_modules"
node supabase/tests/run-shared-circle-shop.mjs "$sumore_test_deps/node_modules"
node supabase/tests/run-account-access.mjs "$sumore_test_deps/node_modules"
node supabase/tests/run-feedback-reports.mjs "$sumore_test_deps/node_modules"
node supabase/tests/run-immutable-friend-codes.mjs "$sumore_test_deps/node_modules"
node supabase/tests/run-circle-starting-balance.mjs "$sumore_test_deps/node_modules"
node supabase/tests/run-circle-membership-controls.mjs "$sumore_test_deps/node_modules"
```

Run these commands from the repository root. Each runner selects the migrations and fixtures relevant to its contract. PGlite has one connection, so passing tests do not prove concurrent transaction behavior or hosted Auth configuration.

## Real PostgreSQL and Auth

The native PostgreSQL runners create temporary clusters to check concurrent operations and current database contracts. Supply the absolute directory containing your PostgreSQL 17 binaries:

```sh
node supabase/tests/run-circle-membership-concurrency.mjs /absolute/path/to/postgresql/bin
node supabase/tests/run-panic-zero-balance.mjs /absolute/path/to/postgresql/bin
node supabase/tests/run-community-moderation.mjs /absolute/path/to/postgresql/bin
node supabase/tests/run-community-moderation.mjs /absolute/path/to/postgresql/bin --owner-upgrade
node supabase/tests/run-community-moderation.mjs /absolute/path/to/postgresql/bin --owner-path
```

The runner uses a private Unix socket and does not read an existing database URL. The [real Auth acceptance runner](REAL_AUTH_ACCEPTANCE.md) additionally starts a loopback-only Auth service to test identity conversion, recovery, session refresh, and deletion.

## Hosted smoke tests

Hosted tests create and delete real disposable accounts and write to their groups. They are not part of the default offline suite. Use an explicitly selected test project that you own, with no real users, and inspect the script before running it:

```sh
node supabase/tests/run-hosted-setup-smoke.mjs \
  --confirm-project YOUR_TEST_PROJECT_REF \
  --env-file /absolute/private/path/test.env \
  --create-disposable-accounts

node supabase/tests/run-hosted-circle-smoke.mjs \
  --confirm-project YOUR_TEST_PROJECT_REF \
  --env-file /absolute/private/path/test.env \
  --create-disposable-accounts
```

The environment file contains the test project's public URL and publishable key. Its hostname must match `--confirm-project`. The runners keep private receipts for cleanup; inspect any cleanup failures and remove only the records identified by that run. Empty test groups may remain. Do not publish diagnostic logs or receipts containing account identifiers.

The setup runner's optional `--send-feedback` flag sends real email. Leave it off unless you have deliberately configured your own test sender and inbox.

## Boundaries

Passing backend tests does not prove device authorization, secure storage, notification delivery, or app blocking. Use the [physical-device checklist](../../docs/testing.md) alongside backend tests. Read-only SQL audits in this directory are separate from mutation fixtures; review each file before choosing a target.
