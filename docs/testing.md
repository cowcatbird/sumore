# Testing

Run tests at the layer you change. Browser previews and source-level assertions cannot prove app blocking, notifications, or secure storage on a phone.

## Application and website

From `apps/mobile`:

```sh
npx tsc --noEmit
npm run lint
npm test
```

From the repository root:

```sh
node --test sumore-support/validate-site.test.mjs
```

Tests include domain rules, component interactions, account-bound responses, permission consent, and native configuration contracts. Test counts are not a release guarantee.

## Backend

See [backend tests](../supabase/tests/README.md) for in-memory PostgreSQL, real local Auth, and concurrency runners. Use isolated databases and disposable accounts. Hosted tests make real writes and require an explicit project reference and environment file; never point them at the public service or a backend containing real users.

## Native unit tests

After generating an Android native project, run from `apps/mobile/android`:

```sh
./gradlew :screen-time:testDebugUnitTest
```

The iOS Foundation-only grant tests can run on macOS from `apps/mobile`:

```sh
swiftc modules/screen-time/ios/ScreenTimeGrant.swift modules/screen-time/tests/ScreenTimeGrantTests.swift -o /tmp/sumore-grant-tests
/tmp/sumore-grant-tests
```

Build the native targets as well. Source parsing and unit tests do not verify signed entitlements or operating-system behavior.

## Physical device checks

Test on both platforms with a backend and accounts you control:

- Complete onboarding by tapping and swiping. Deny, grant, revoke, and restore each permission.
- Select apps, configure shared and per-app limits, and verify each limit independently. Keep a selected app open when its time runs out.
- Request extra time from another account, approve it, and verify access starts without a second confirmation. Duplicate or delayed responses must not extend the deadline.
- Check grant expiry while foregrounded, backgrounded, locked, and after restarting the device. Repeat after a timezone or clock change.
- Verify denied requests and unauthorized accounts cannot grant time.
- Test the panic button with positive and zero s’mores; the balance must never become negative.
- Switch accounts, recover an account, and delete a disposable account. Confirm no previous account's selection, grant, or private key leaks into the next session.
- Receive requests and decisions with the app closed. A local notification test alone does not verify remote delivery.
- Exercise joining, leaving, blocking, reporting, moderation notices, and opt-in shared labels with multiple accounts.

Record the device model, OS version, app version, and result when reporting a native bug. Remove credentials and other people's details from screenshots and logs.
