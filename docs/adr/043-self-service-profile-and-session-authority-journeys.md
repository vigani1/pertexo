# ADR 043: Self-service display name and session-authority identity journeys

- **Status:** accepted
- **Date:** 2026-09-25
- **Related:** ADR 004, ADR 038 (amended below), ADR 039, ADR 040
- **Amended:** 2026-09-25 by [ADR 047](047-workspace-membership-lifecycle.md),
  which adds `/w/{workspaceId}/team` to the return allowlist

## Context

Three identity journeys stopped at the edge of the Better Auth cutover:

1. People cannot change their display name. The backend plan defines
   `/v1/users/me` as a read, and ADR 039 disabled Better Auth's native
   `/update-user` with the other routes that bypass Pertexo policy.
2. Invitation acceptance is registered only when legacy OIDC is configured,
   because the recipient proof comes from an OIDC callback. A deployment whose
   only session authority is Better Auth cannot accept invitations.
3. After email verification or a forced fresh sign-in, people land on the
   workspace picker instead of the page that sent them, such as the
   invitation or Account & security.

## Decision

### Display names belong to the identity/workspace module

`app.users` is Pertexo's user record. Better Auth maps its `name` field onto
`display_name` for sign-up only; it owns credentials, sessions and account
linking, not profile data (ADR 039). The display name is what teammates see in
member lists and invitation mail, so the identity/workspace module owns
changes to it, behind whichever session authority is active.

- `PATCH /v1/users/me` with a strict `{ displayName, expectedRevision }` body,
  cookie session (`SessionAuthenticationGuard`, which resolves the active
  authority), double-submit CSRF, `Idempotency-Key` and the `actor_mutation`
  rate class. The actor is always the session's user: there is no user ID in
  the route or body, so this stays self-profile access, not user
  administration.
- The contract validates the name: trimmed, 1–128 characters, no control
  characters (`userDisplayNameSchema`). Longer names created before this
  limit still display; changing them requires a shorter one.
- `app.users.profile_revision` (positive, starting at 1) fences stale edits;
  `GET /v1/users/me` now returns it as `revision`. A stale revision is
  `412 user.profile_revision_conflict`.
- Actor-scoped receipts in `app.user_profile_command_receipts` replay exact
  retries. They are identity-scoped platform rows (no workspace, no tenant
  policy), keep only the applied name, revision and change flag, and are
  deleted with the user. A key reused with another body is
  `409 request.idempotency_conflict`.
- A real change records the identity-scoped audit fact
  `profile.display_name_changed` through the owner-held
  `record_identity_profile_audit_fact` function, in the same transaction. The
  fact never contains the name. A no-op keeps the revision and writes no fact.
- The change does not rotate or revoke sessions: it grants no authority.
- Better Auth's native `/update-user` stays disabled.

### Invitation acceptance runs under the active session authority (ADR 038 amendment)

The invitation-acceptance routes (`resolve`, read, `complete`, abandon) are
always registered. How the recipient is proven depends on the authority:

- With legacy OIDC configured, `POST /v1/invitation-acceptance/oidc` keeps the
  ADR 038 flow unchanged.
- A session authority that verifies email at sign-in (Better Auth) supplies
  **sign-in evidence**: the session's user, verified email and the time the
  session was issued. `POST /v1/invitation-acceptance/session` (session
  cookie, double-submit CSRF, the journey's invitation CSRF header,
  `identity_start` rate class, strict empty body) records it as the journey's
  recipient proof when the email is verified and the session was issued at
  most five minutes ago — the same freshness bound as an OIDC result. The
  proof time is the sign-in time, so the five-minute acceptance window starts
  at sign-in, not at the request. An older session is
  `409 workspace.invitation_proof_expired`; the browser signs in again and
  returns to the invitation. An authority without sign-in evidence answers
  `404`.

Everything else in ADR 038 is unchanged: exact normalized email match,
wrong-account handling, browser binding, single rotation of the accepting
user's sessions into the active authority's store, receipts and recovery. An
old browser session is still never trusted as proof.

### Return targets are an allowlist, carried only as data

`returnTo` is a same-origin app path that must match one of the known routes
`/invitations/accept`, `/account/security` or `/w/{workspaceId}/account`
(`authenticationReturnPathSchema` in contracts). No scheme, host, `//`, query
or fragment is accepted, and the web router validates it in the sign-in,
sign-up and sign-out search schemas.

- Password sign-in navigates to the validated path; social sign-in uses it as
  Better Auth's `callbackURL`.
- Email verification is Pertexo-owned (ADR 039). When sign-up or a
  verification resend asks for `/login?verified=true&returnTo=…` on this
  origin, the server keeps only an allowlisted `returnTo`, adds it to the
  verification link, and after consuming the proof lands on this origin's
  `/login?verified=true&returnTo=…`. The landing path is fixed, so the
  parameter can never become an open redirect; anything else is dropped.

## Consequences

Better Auth-only deployments can accept invitations, and people can rename
themselves without a new session authority or a native Better Auth route.
Freshness is measured from session issue time, which Better Auth also uses
for its own fresh-session checks. Display-name receipts are retained for the
life of the user; they are small and bounded by the actor rate limit.
