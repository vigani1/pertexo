# F31 — Two-factor sign-in

Status: approved by the owner 2026-10-19; ready for implementation.
Parent: [product roadmap](../product-roadmap.md). Size: **M**.

## Outcome

Someone who signs in with an email and password can add a second step: a
six-digit code from an authenticator app (1Password, Google Authenticator,
Authy and so on). If they lose the device, a one-time recovery code gets them
in. This matches [n8n's two-factor sign-in](https://docs.n8n.io/user-management/two-factor-auth/)
(authenticator app and recovery codes). Zapier and Make offer the same.

## Today

- Password sign-in is Better Auth's `emailAndPassword`, configured in
  `apps/api/src/authentication/better-auth/options.ts` (base path `/v1/auth`).
- The trusted-session plugin (`better-auth/session-plugin.ts`) re-checks the
  organization sign-in policy after `/sign-in/email` creates a session
  (`isAuthenticationSessionAllowed`). If the policy changed, it deletes the
  session and answers `AUTHENTICATION_CHANGED`.
- Sign-in rate limits live in `better-auth/fastify.ts` (`AbuseRateLimitPolicy`
  endpoint classes).
- The account page is `apps/web/src/features/auth/pages/account-security.tsx`.
  It has three tabs: Profile, Sign-in & security (`components/account/methods-section.tsx`,
  `password-section.tsx`) and Sessions. Its read model is
  `accountSecurityResponseSchema` in `packages/contracts/src/schemas/identity/authentication.ts`.
- The web sign-in call is `signInWithEmail` in
  `apps/web/src/features/auth/data/native-auth.api.ts`. The page is
  `features/auth/pages/login.tsx`, with `components/sign-in/use-submit.ts`.
- Auth tables (`users`, `auth_accounts`, `auth_sessions`,
  `auth_verifications`) are defined in
  `packages/database/src/schema/authentication.ts`.
- Organization single sign-on and provisioning (F28) and social sign-in exist.
  Sensitive account actions require a session no older than five minutes
  (`freshAge`, `identity.session_not_fresh`).
- Better Auth 1.7.7 already ships a `two-factor` plugin:
  - TOTP codes, backup codes and email OTP
  - routes `/two-factor/enable`, `/disable`, `/get-totp-uri`, `/verify-totp`,
    `/generate-backup-codes` and `/verify-backup-code`
  - a `twoFactorEnabled` user field and a `twoFactor` table

## Decisions

1. **Use Better Auth's two-factor plugin** with TOTP and backup codes. Don't
   add a second implementation. Turn off its email-OTP route (`/two-factor/send-otp`,
   `/two-factor/verify-otp`) through `disabledPaths`. An emailed code is weak
   when the mailbox is also how the password gets reset, and n8n doesn't offer it.
2. **It applies to password sign-in only.** People who sign in through
   organization SSO or a social provider are verified by that provider, which
   owns their second factor. This matches n8n, where enforcement covers only
   email and password logins. The guide says so plainly.
3. **Turning it on** happens on Account & security → Sign-in & security, in a
   new "Two-factor sign-in" section:
   1. Confirm the password; Better Auth's enable route requires it.
   2. A QR code and the same key as text, for apps that can't scan.
   3. Enter a code from the app. The plugin keeps two-factor off until this
      first code is verified; don't skip that check.
   4. Ten recovery codes, shown once, with Copy and Download (.txt) and a
      required "I've saved these codes" checkbox before Done.

   Draw the QR code in the browser with one small library that renders SVG
   and has no dependencies (for example `uqr`). The `otpauth://` URI holds the
   secret, so it must never be sent to an outside QR service.
4. **Signing in.** After a correct password, the sign-in page shows "Enter the
   6-digit code from your authenticator app", with a link "Use a recovery code
   instead". The session is created only after a code verifies, and the
   plugin's short-lived two-factor cookie bridges the two steps (keep its
   default lifetime). Codes are digits only; accept pasted codes with spaces.
5. **The same session checks apply on the code step.** Add `/two-factor/verify-totp`
   and `/two-factor/verify-backup-code` to the trusted-session plugin's
   after-hook matcher. That way the organization-policy re-check and the
   `AUTHENTICATION_CHANGED` refusal also apply when the session is created by
   the code step. Make sure the plugins' hooks run in the right order:
   two-factor creates the session, then the policy check sees it.
6. **Rate limits and lockout.** Code verification counts against the existing
   sign-in rate-limit class. Add the two verify routes to the same endpoint
   class as `/sign-in/email`, so guessing codes is limited like guessing
   passwords. Keep the plugin's own account lockout at its defaults as well:
   ten wrong codes in a row lock that person's code step for fifteen minutes,
   whichever addresses the guesses come from, and a right code resets the
   count. The rate limit slows one address; the lockout stops guessing spread
   over many.
7. **Recovery codes** are single use and stored the way the plugin stores
   them, encrypted with the auth secret. "Get new recovery codes" replaces
   all old ones, needs a fresh session and the password, and shows the new
   set once. The section shows how many unused codes remain, and warns when
   two or fewer are left.
8. **Turning it off** needs the password. Other sessions stay signed in.
9. **A password reset doesn't remove two-factor.** The next sign-in still asks
   for a code.
10. **Lost device and lost recovery codes.** Operators get one privileged
    command in `apps/ops` to remove a person's two-factor by email address.
    It prints what it did and needs the operator's database access, like
    other ops commands. There's no self-service bypass.
11. **Security emails.** Send one when two-factor is turned off and when
    someone signs in with a recovery code, through the existing durable
    authentication mail (`apps/api/src/authentication/mail`). The email never
    contains codes.
12. **Read model.** `accountSecurityResponseSchema` gains
    `twoFactor: { enabled: boolean; recoveryCodesRemaining: number | null }`.
    `recoveryCodesRemaining` is `null` when off.
13. **Fresh-session rules** stay as they are. A session created after the code
    step is fresh like any new session, so `signInEvidence` keeps working.

## Data

- Migration:
  - `users.two_factor_enabled boolean not null default false`
  - table `app.auth_two_factors`: id, `user_id` unique with a foreign key to
    users on delete cascade, `secret`, `backup_codes`, `verified`,
    `failed_verification_count integer not null default 0`, nullable
    `locked_until timestamptz`, timestamps. The last two are the plugin's
    `failedVerificationCount` and `lockedUntil`, which Better Auth 1.7.7 reads
    and writes for its lockout (found in implementation review, #422).

  Map the names through the plugin's `schema` option, like the other auth
  tables (snake_case, `auth_` prefix). Copy the grants and row-security
  treatment of `auth_accounts`.
- Follow the usual migration steps in this repository:
  - generate with `pnpm run db:generate`, then hand-edit the grants
  - run Prettier on `migrations/meta`
  - bump `EXPECTED_MIGRATION_HEAD` in `packages/database/src/platform/readiness.ts`
  - add the migration to the upgrade-test lists

## Slices

1. **Backend.**
   - plugin setup, migration, `disabledPaths` for the email OTP routes
   - session-hook coverage for the verify routes, rate-limit classes, and the
     account-security read field
   - integration tests against real PostgreSQL:
     - turn on, then password sign-in asks for a code
     - a wrong code is refused, a right code gives a session
     - a backup code works once
     - turning off needs the password
     - SSO and social sign-in are unaffected
     - an organization policy change between the password and the code gives
       `AUTHENTICATION_CHANGED`
     - the rate limit applies to codes
     - ten wrong codes lock the code step, a right code after the lock ends
       works and resets the count
2. **Web.**
   - the "Two-factor sign-in" section: turn on with QR, key text, first-code
     check and recovery codes; turn off; new recovery codes; remaining count
   - the code step on the sign-in page, with the recovery-code alternative,
     and a plain message when the lockout is on ("Too many wrong codes. Try
     again in 15 minutes.")
   - loading, error and phone states, keyboard use, and `inputmode="numeric"`
     with `autocomplete="one-time-code"` on the code field
   - mocked browser tests, plus a live journey that generates real TOTP codes
     from the secret in the test
3. **Support and safety.** The two security emails, the ops command, and a
   short guide `docs/guides/two-factor-sign-in.md`.

Each slice is its own PR and leaves the product working. Slice 1 changes no
visible behavior until slice 2 adds the controls.

## Acceptance

- [ ] A person turns two-factor on with a real authenticator app, signs out,
      and can't sign in without a code.
- [x] A recovery code works once and is then refused; the remaining count
      drops.
- [x] Wrong codes are rate-limited like wrong passwords, and ten in a row
      lock the code step for fifteen minutes.
- [x] Turning off and getting new codes both need the password and a fresh
      session.
- [x] SSO and social sign-in never ask for a code.
- [ ] The secret and codes never appear in logs, URLs or error messages.
- [ ] The phone layout works, and the code field opens the numeric keyboard
      on iPhone.
- [ ] The guide is published and the roadmap row is updated.

## Non-goals

- Passkeys (a later item)
- SMS or emailed codes
- "Trust this device for 30 days"
- Requiring two-factor for every member of a workspace (a later workspace
  setting; the `two_factor_enabled` column keeps that possible)
- Two-factor for API tokens, which are separate credentials

## Delivery tracker

| Slice | Status | PR |
| --- | --- | --- |
| 1 Backend | Implemented; awaiting PR review | [#422](https://github.com/vigani1/pertexo/pull/422) |
| 2 Web | Approved | — |
| 3 Support and safety | Approved | — |

### Backend alignment (owner-approved 2026-10-19)

Code-step account lockout returns `auth.two_factor_locked`, so the web can
identify the account lockout and show its fifteen-minute message. The plugin
owns the lockout counters and timing.

The Fastify bridge already puts all native POST routes in the distributed
`identity_start` class, including both code-verification routes; preserve that
owner and prove it in tests. Strip session tokens from their JSON responses,
just as for password sign-in. Reject `trustDevice: true` at the server boundary,
since remembered devices are outside this feature. Native management routes
reuse the authoritative session, double-submit CSRF and five-minute freshness
rules. Keep the credential-session issuance policy check as well as the
post-issuance check; a policy refusal at the code step is
`AUTHENTICATION_CHANGED` in either case.
