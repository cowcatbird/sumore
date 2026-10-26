# Security

Report security vulnerabilities privately to **cowcatbird.dev@gmail.com** with the subject **Sumore security report**. Do not put exploit details, user data, or credentials in a public issue.

Include the affected version or commit, platform, reproduction steps using your own test accounts, and the expected impact. Remove login keys, access tokens, service-role keys, and identifying information from logs and screenshots.

## Testing boundaries

Use a backend you control and disposable accounts. Do not access other users' data, disrupt the public service, send unsolicited notifications, or perform destructive tests on shared infrastructure.

## Sensitive configuration

Mobile `EXPO_PUBLIC_*` variables are embedded in the app and are not secrets. Only public client configuration belongs there. Keep service-role credentials, webhook secrets, signing keys, Firebase service-account files, and store credentials outside Git.

Friend codes identify accounts for circle invitations. They are not authentication credentials. Private login keys are credentials and must never be requested in support email or shared in issues.

Account recovery, deletion, grant claims, and moderation require server-side authorization. A client-side check alone is not an access-control boundary. Native permissions remain under the device owner's control.

If a credential is exposed, revoke or rotate it at the provider first. Removing it from the repository does not invalidate a copy already obtained by someone else.
