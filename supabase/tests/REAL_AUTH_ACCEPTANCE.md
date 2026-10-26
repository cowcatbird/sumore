# Local Auth acceptance

`run-real-account-access.mjs` exercises the account-access handler against real Supabase Auth and PostgreSQL services in a disposable local environment. It does not use hosted project credentials or an existing database.

## Requirements

- Node 22.18 or newer for built-in TypeScript support, plus installed mobile dependencies.
- PostgreSQL 17 binaries, without starting a shared database service.
- A compatible Supabase Auth release binary with its migration directory. Verify the download against its official release checksum before execution.

From the repository root, supply absolute paths:

```sh
node supabase/tests/run-real-account-access.mjs /absolute/path/to/auth /absolute/path/to/postgresql/bin
```

The runner creates a private temporary directory, fresh database cluster, random credentials, and loopback-only service ports. It does not read `.env` files, external database URLs, or hosted credentials. Email is directed to a closed loopback port rather than a real provider.

## Coverage

The tests exercise anonymous identity conversion, login-key hashing, recovery and refresh, previous-key cleanup, MFA restrictions, invalid tokens and keys, rate-limit concurrency, feedback reservations, shared purchases, and self-deletion. Account and group fixtures belong only to the test run.

Both services stop during cleanup. The temporary cluster and logs remain for debugging; treat them as private because failure output may contain test credentials.

The handler is imported directly and the RPC adapter uses PostgreSQL roles and claims. This does not test the deployed Edge gateway, PostgREST routing, forwarded-IP trust, an email provider, or device SecureStore. Use a separately selected disposable hosted project and physical devices for those boundaries.
