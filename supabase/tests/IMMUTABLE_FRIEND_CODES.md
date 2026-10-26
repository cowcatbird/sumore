# Friend code tests

Migration `0027_immutable_friend_codes.sql` makes public friend codes server-generated and immutable. Existing codes remain intact. New accounts receive random eight-character codes; profile updates and the legacy editing endpoint cannot change them.

A friend code identifies an account for circle invitations. It is not proof of ownership and cannot recover an account. Recovery uses a private login key and preserves the original account and friend code.

From the repository root, with a separate PGlite dependency directory:

```sh
node supabase/tests/run-immutable-friend-codes.mjs /absolute/path/to/test/node_modules
```

The runner creates an in-memory database and checks existing-code preservation, random-code format, uniqueness, supplied-code rejection, permissions, legacy RPC denial, and profile/join compatibility. It also tests bounded collision retries and verifies that unrelated insert errors are not swallowed.

No project credentials, real accounts, or network connections are used. These single-connection checks do not replace concurrency testing or verification that a particular hosted database has applied the migration.
