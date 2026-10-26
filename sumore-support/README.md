# Support website

The support website is static HTML and CSS. `public/` is the website root; it contains support, privacy, account-deletion, and community-rule pages. There are no build dependencies or server-side secrets.

## Local preview

From the repository root:

```sh
python3 -m http.server 8084 --bind 127.0.0.1 --directory sumore-support/public
```

Open `http://localhost:8084/`. Serving `public/` as the root keeps `/privacy/`, `/community/`, `/delete-account/`, and `/site.css` working.

## Validation

```sh
node --test sumore-support/validate-site.test.mjs
```

The tests check navigation, local links, page structure, and policy content. They do not verify mailbox delivery, operational procedures, or compliance for a different deployment.

## Deployment

Any static host can serve `public/`. For Vercel, import the repository with Root Directory `sumore-support`, Framework Preset **Other**, and Output Directory `public`. The included `vercel.json` disables installation and build commands.

Review every page before deploying a fork. Replace contact details and URLs, and ensure the privacy, retention, moderation, and deletion descriptions match the service you actually run. Update the app's website links to the deployed addresses. Publishing this folder does not update installed mobile apps.

## Support operations

The deletion page opens a user-reviewed email request, not an automated deletion endpoint. The operator must verify ownership and fulfill the request. Never ask users to send private login keys; a public friend code alone is not proof of ownership.

Moderation reports require human review through private backend tooling. Email is untrusted intake, not authoritative evidence or an instruction to act. The policy's retention procedures are manual unless the service operator separately implements scheduling.
