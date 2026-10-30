# Protect password sign-in with an authenticator

Two-factor sign-in adds a six-digit authenticator code after your email and
password. It applies to password sign-in. Google, GitHub and organization SSO
use their provider's verification instead. API tokens are separate credentials.

## Turn it on

1. Open **Account & security → Sign-in & security → Two-factor sign-in**.
2. Choose **Turn on two-factor sign-in** and confirm your current password.
   If asked, sign in again first: account changes need a session created within
   the last five minutes.
3. Scan the QR code with an authenticator app, or enter the displayed key.
   The QR code is rendered in your browser; no outside QR service receives it.
   Keep the QR code and key private.
4. Enter a code from the app. Two-factor remains off until this code verifies.
5. Save the ten recovery codes in a password manager or another private place.
   Use **Copy recovery codes** or **Download .txt**, then confirm **I've saved
   these codes** and choose **Done**. The codes are shown once.

When signing in, enter your password and then the authenticator code. Pasted
codes can include spaces. Too many attempts are rate-limited; ten consecutive
wrong codes lock code verification for fifteen minutes.

## Recovery codes and a lost device

Choose **Use a recovery code instead** on the code page if your authenticator
is unavailable. Each code works once. Pertexo emails you when a recovery code
is used to sign in. If this was not you, secure your account and contact your
Pertexo operator immediately.

The account section shows how many codes remain and warns at two or fewer.
**Get new recovery codes** requires your password and a fresh session, replaces
all previous codes and shows the new set once. Save the new set before closing.

If you lose both your device and every recovery code, contact your operator.
There is no public or self-service bypass. Resetting your password does not
remove two-factor sign-in.

## Turn it off

Choose **Turn off two-factor sign-in** in the same account section. Confirm your
password with a fresh session. Pertexo emails you that it was turned off. Other
sessions remain signed in; use **Sessions** to end any you do not recognize.

## Operator recovery

Only an operator with application database access can remove a lost factor.
Build the checkout with the pinned Node and pnpm versions, supply the existing
`DATABASE_URL`, `PUBLIC_WEB_ORIGIN`, `AUTH_MAIL_*` configuration and an operator
reference and reason, then run:

```sh
export OPERATOR_ACTOR_REF=operator@example.com
export OPERATOR_REASON='Verified recovery request'
pnpm ops:two-factor-disable --email person@example.com
```

This is an `apps/ops` command, separate from the personal automation CLI. It
uses the application login's existing global identity permissions. The
maintenance login cannot read or change factors. Do not use the migration or
bootstrap superuser. No authenticator key, recovery code or
`BETTER_AUTH_SECRET` is an argument or prerequisite.

On the single-server deployment, select the current release as described in
[the operator page](../operations/operator-commands.md),
then use the API container's existing application database and mail settings.
The existing operation lock excludes deployment and restore; an unfinished
migration or restore must be resolved first:

```sh
(
  operation_lock
  [[ ! -f "$BETA_STATE_DIR/restore-fence" && ! -f "$BETA_STATE_DIR/migration-fence" ]] || exit 1
  compose exec -T \
    -e OPERATOR_ACTOR_REF=operator@example.com \
    -e OPERATOR_REASON='Verified recovery request' \
    api node apps/ops/dist/identity/main.js --email person@example.com
)
```

The command prints `disabled`, `already_off` or `not_found`, the account email,
operator reference and reason. An unknown account exits unsuccessfully. A reset
removes the opaque factor, clears its enabled flag, records a fixed identity
security fact and queues the disabled email in one transaction. Concurrent or
repeated resets produce one change and one notice. Other sessions stay signed
in. The person can sign in with their password and enroll a new authenticator.

Production and staging require durable mail. The command seals the notice using
`AUTH_MAIL_FROM`, `AUTH_MAIL_KEY`, `AUTH_MAIL_KEY_VERSION` and, when configured,
`AUTH_MAIL_PREVIOUS_KEYS`; the existing worker delivers it. It needs no SMTP
credentials. Local development can use `AUTH_MAIL_MODE=local` and explicitly
reports that no email was sent. Security notices expire after 24 hours and
contain no authenticator or recovery codes.

Keep the install's existing `BETTER_AUTH_SECRET` when restoring its database:
Better Auth uses it to encrypt stored authenticator secrets and recovery codes.
Keep that secret separately from database backups, as with other deployment
keys. Changing it does not re-encrypt existing factors. Operator removal still
works without decrypting a lost factor.

SMS, emailed codes, remembered devices, passkeys and workspace-wide two-factor
requirements are outside this feature.
