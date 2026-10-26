# Supabase backend

The backend provides accounts, circles, requests, approved time grants, shared purchases, and moderation. Run your own Supabase project when developing a fork. Client configuration and migration files do not grant access to an existing deployment.

## Local development

Install the Supabase CLI and a Docker-compatible container runtime. From the repository root:

```sh
supabase start
supabase status
```

The local stack applies the migration files in `supabase/migrations` and is useful for backend development and tests. The mobile client's URL guard accepts hosted `https://*.supabase.co` projects, not localhost. Use your own hosted development project for connected mobile accounts; use the isolated browser preview for UI work without a backend.

`supabase db reset` recreates the local database and deletes its data. Use it only for disposable local development, never as a command to repair a hosted service.

## Hosted development project

1. Create a Supabase project you control.
2. From the repository root, run `supabase login` and `supabase link --project-ref YOUR_PROJECT_REF`.
3. Review `supabase db push --dry-run`, then run `supabase db push` to apply the migrations to that project.
4. Enable anonymous sign-in in Auth settings. Account recovery also uses email identities and the Auth admin APIs; keep the email provider enabled.
5. Configure Auth redirects for your app's scheme and development URLs.
6. Set the mobile app's `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to this project.

Apply migrations in order, including later files that replace earlier policies. Gaps in migration numbers are intentional. For existing installations, review changes and take a backup before applying migrations; do not rewrite previously applied files.

## Edge Functions

Deploy account access after the database migrations:

```sh
supabase functions deploy account-access
```

The function's gateway JWT check is disabled in `config.toml`, but the handler verifies every bearer token with Supabase Auth before privileged work. Database recovery helpers are not exposed to mobile API roles.

See [Edge Functions](functions/README.md) for notification and optional email setup. For local functions, use `supabase functions serve` with a private environment file containing only your local values.

## Remote notifications

1. Generate a long random webhook secret and store `DATABASE_WEBHOOK_SECRET` as an Edge Function secret.
2. Deploy `push-notifications` with `supabase functions deploy push-notifications --no-verify-jwt`.
3. Make a private copy of `webhook-trigger.example.sql`, replace the function URL and secret placeholders, and run it in your project's SQL editor. The triggers send request changes and panic events to the function.
4. Configure your own Expo project, Apple push credentials, and Android Firebase credentials. Install a native build and register a device token.

Never commit the filled-in webhook SQL or server secrets. A local notification test is not a remote-delivery test; verify requests and approvals between two physical devices.

## Moderation and deletion

The database enforces community-rule acceptance, blocking, reporting, and moderation actions. A database owner can review reports using `operators/community-moderation-review.sql`. Keep the private moderation schema out of exposed API schemas; do not grant client access to it.

Reports require human review. Treat email as untrusted intake, not authority to restrict an account. Review the saved evidence and current report version before taking an action. Establish your own report-review, appeals, deletion, and retention procedures before operating a public service.

In-app account deletion uses the authenticated `account-access` function. Deleting the app from a phone does not automatically delete server data. The support site's email deletion request needs ownership verification and manual fulfillment.

## Tests

See [backend tests](tests/README.md). Start with disposable local runners. Hosted smoke tests make real writes and must target an explicitly selected test project without real users.
