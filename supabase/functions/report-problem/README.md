# Optional support email delivery

This endpoint supports authenticated server-side delivery of a problem report. The current mobile app instead opens a user-reviewed email draft, so this function is optional and is not part of that flow.

## Configuration

Set `RESEND_API_KEY` and `FEEDBACK_FROM` as private Supabase Edge Function secrets. The sender must be verified by the email provider. Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Review the fixed recipient in `core.ts` before deploying a fork.

Apply the database migrations, then deploy with:

```sh
supabase functions deploy report-problem
```

The handler verifies the caller's bearer token with `auth.getUser`. Missing provider configuration returns an unavailable response before reserving a report.

## Request and retry behavior

The authenticated POST body contains `id` (a client-generated UUID), `message`, `platform`, and `appVersion`. Messages must contain 10–4,000 characters. Supported platforms are `ios`, `android`, and `web`.

Retain the same report ID and exact payload when retrying an uncertain result. Clear the draft only after `{ "sent": true, "reportId": "..." }`. Editing a submitted draft needs a new ID.

The database reserves a send lease, enforces account quotas, and prevents simultaneous duplicate sends. Provider calls use stable idempotency keys. Unconfirmed reports older than the retry window need operator reconciliation rather than a blind resend. Account deletion removes stored report content but cannot retract email already delivered.

Plain-text delivery includes the report ID, verified account ID, platform, version, and message. It does not attach app selections, login keys, device logs, or screenshots. Do not log message bodies or provider credentials.

## Tests

From the repository root:

```sh
node apps/mobile/node_modules/vitest/vitest.mjs run --config supabase/functions/report-problem/vitest.config.mjs
```

See [backend tests](../../tests/README.md) for SQL quota and lease tests. Any end-to-end email test must use your own sender and recipient; it sends a real message.
