# Account access

This function handles private login-key creation, recovery, key replacement, and account deletion. Public friend codes are not accepted as login credentials.

Apply all database migrations before deploying the function. Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`; no custom signing secret is required. Every request verifies the bearer with `auth.getUser`, even though gateway JWT verification is disabled in `config.toml`.

## Authentication requirements

The project must support anonymous sign-in, email identities, admin user updates, admin magic-link generation, and magic-link OTP verification. The first key for an identity-less anonymous account attaches a stable, non-deliverable `accounts.sumore.invalid` identity to the same user UUID. Existing email identities are preserved. No recovery email is sent.

Key recovery exchanges a server-only one-time token for a normal refreshable Auth session. Accounts with a verified MFA factor cannot use this recovery path. Test these Auth operations on your own isolated project before distributing account controls.

## Credential handling

- Keys contain 24 cryptographically random bytes. The database stores only their SHA-256 hashes.
- Native device copies use SecureStore. Browser copies remain in tab memory, not persistent browser storage.
- Replacing a key invalidates the previous key, but does not revoke sessions already issued with it.
- Recovery restores the target account rather than merging or deleting another account. A short-lived, one-use cleanup ticket can retire the previous account's captured key after the switch.
- Account operations bind to their initiating identity so a queued delete or key replacement cannot act on a newly recovered account.
- Rate limits and uniform invalid-key responses limit guessing. Request bodies, raw keys, tokens, and sessions must not be logged.

Self-deletion removes the authenticated account's data through the server flow. Shared circle records and other members' data follow the database's preservation rules; deletion must not erase another member's account or wallet.

## Tests

Application and handler tests run with the mobile test suite. SQL tests and the real Auth runner are described in [backend tests](../../tests/README.md) and [local Auth acceptance](../../tests/REAL_AUTH_ACCEPTANCE.md). Use disposable identities only; never test recovery or deletion on another person's account.
