# Edge Functions

Deploy these functions to your own Supabase project after applying its database migrations.

| Function | Authentication | Purpose |
| --- | --- | --- |
| `account-access` | Bearer verified with `auth.getUser` | Private login keys, recovery, and account deletion |
| `push-notifications` | `x-webhook-secret` checked against `DATABASE_WEBHOOK_SECRET` | Request, approval, and panic notifications through Expo |
| `report-problem` | Bearer verified with `auth.getUser` | Optional server-side support email |

Supabase supplies the function's server URL and service-role environment variables. These credentials must never enter the mobile app or a public repository.

## Deploy

```sh
supabase functions deploy account-access
supabase functions deploy push-notifications --no-verify-jwt
```

`account-access` and `report-problem` disable gateway JWT verification in `supabase/config.toml` to support current token formats. Their handlers still authenticate the caller. The push endpoint instead authenticates its database webhook with a separate shared secret.

The current mobile problem-report flow opens a user-reviewed email draft; it does not invoke the optional `report-problem` function. Deploy that endpoint only if you choose to wire up automated delivery and configure its provider.

For configuration and behavior, see [account access](account-access/README.md), [optional email delivery](report-problem/README.md), and [backend setup](../README.md).
