# ADR 039: Better Auth authentication and browser-session authority

- **Status:** accepted — user approved standard Better Auth session storage
- **Date:** 2026-09-22
- **Supersedes:** the managed-provider selection, authentication-method constraints, custom session ownership and digest-only session-storage rule in ADR 004
- **Does not supersede:** Pertexo authorization, ActorContext, RLS, audit, CSRF, revocation or SSE authorization-lifetime guarantees

## Context

The product decision selects Better Auth for password and social authentication,
with Pertexo-owned React screens and Pertexo-owned workspace authorization. ADR
004 currently selects a managed OIDC provider and a platform browser session whose
database row contains only a one-way token digest. The approved implementation
plan requires one session authority and forbids silently weakening that storage
guarantee.

Better Auth `1.7.5` is the current candidate release. It is compatible with the
repository's Node 24, React 19, PostgreSQL and ESM ranges. Its documented Fastify
integration uses a Fetch `Request`/`Response` bridge; the community NestJS adapter
describes Fastify support as beta, so Pertexo would own and test the small manual
bridge instead of making the community package an authorization dependency.

The candidate's supported database options can rename tables and fields, add
fields, change expiry/refresh behavior and select database, secondary or stateless
session storage. They do not provide a supported session-token-at-rest hashing
hook. Database hooks run around the same session record and do not change the
library's session-token interface.

The candidate's internal session lifecycle requires the retrievable `session.token`
for all of these operations:

- writing and later validating the signed session cookie;
- finding, refreshing and deleting the current session;
- listing active sessions;
- revoking one supplied session; and
- listing and deleting every session except the current one.

A custom database adapter can hash a raw token used in a direct lookup, but it
cannot reconstruct the other sessions' raw tokens for list/revoke operations.
Returning token digests would expose lookup material and still fails native current-
session comparison. Returning synthetic handles requires undocumented, context-
dependent translation inside the library lifecycle. Stateless or cookie-cached
sessions do not preserve ADR 004's immediate durable revocation and per-event SSE
authorization properties. A private fork could alter these semantics but is not a
supported maintainable adapter.

## Feasibility result

The initially recommended hybrid—Better Auth verifies credentials and social
callbacks while `OpaqueSessionService` remains the sole browser-session
authority—is **not supported by the candidate's public lifecycle** without
rebuilding it.

The bounded follow-up inspection established:

- email/password signup can set `autoSignIn: false`, and ordinary email
  verification can leave `autoSignInAfterVerification` disabled;
- password-reset request and consumption can run without an authenticated
  session;
- successful password sign-in always calls `internalAdapter.createSession`, sets
  a Better Auth session cookie and returns that session token;
- successful social sign-in/callback always reaches `handleOAuthUserInfo`, which
  creates a Better Auth session before the callback writes its cookie;
- `verifyPassword` uses `sensitiveSessionMiddleware`, while social link/unlink and
  other account-security endpoints use Better Auth's session middleware;
- password and email changes likewise depend on the Better Auth session and its
  session revocation/rotation operations; and
- after hooks run after the endpoint handler, so they cannot prevent session
  creation. A before hook can replace the endpoint entirely, but must then own
  user lookup, timing-safe failure, verification gates, OAuth state/callback,
  explicit linking, recent proof and concurrency policy itself.

`better-auth/crypto` publicly exports password hashing and verification helpers,
and selected OAuth helpers are exported, but composing those primitives behind
new Pertexo endpoints would rebuild the authentication lifecycle rather than use
Better Auth as the approved lifecycle owner. Calling stock sign-in, discarding its
cookie and deleting the created session is also rejected: it mints a hidden second
session and leaves an authorization gap when cleanup fails.

The A0 package-artifact assertion checked these seven properties directly against
the published `1.7.5` files and passed 7/7. No runtime dependency or application
authentication change was introduced by the proof.

## Accepted decision

On 2026-09-22 the user explicitly approved option 1 below: use Better Auth's
supported database-session lifecycle as the sole browser-session authority and
accept its token-bearing database representation. This removes the policy blocker,
not the implementation verification gates. Do not maintain a lifecycle fork or
combine Better Auth sessions with separately issued Pertexo sessions.

Persisted session identifiers are sensitive authentication material. Restrict
database and backup access, protect transport and storage, keep signing secrets
separate from session rows, and redact identifiers from logs and application
responses. Never expose raw other-session tokens for a session-management UI;
resolve user-scoped non-secret IDs server-side and guard native endpoints that
would bypass that policy. Verify the exact signed-cookie and any token-accepting
endpoint behavior in the pinned release rather than assuming a database leak is
harmless. The reduced defense in depth versus digest-only storage is accepted.

Keep server-authoritative revocation, no session cookie caching initially,
existing CSRF/origin defenses, secure cookies, rotation, fresh workspace checks,
and SSE authorization deadlines. Existing internal session interfaces may adapt
to Better Auth; they must not issue an independent browser credential.

### Considered options

Better Auth may still own password, email, social and account-linking lifecycle,
while Pertexo keeps stable user IDs, memberships, authorization and tenant data.
The compatible policies considered were:

1. **Accept Better Auth's database session representation.** Persist Better Auth's
   random token identifier and rely on its signed HttpOnly cookie as the complete
   browser credential. This follows the supported stock lifecycle, but explicitly
   weakens ADR 004's digest-only-at-rest rule even though a database leak of the
   identifier alone does not include the cookie signature.
2. **Maintain a private session-lifecycle fork.** Add token hashing and non-secret
   session handles throughout Better Auth's internal adapter and endpoints. This
   preserves the literal storage rule but creates an upgrade-sensitive security
   fork and is rejected unless the user explicitly accepts that operational cost.
3. **Do not adopt Better Auth as the lifecycle owner.** Keep ADR 004 and select a
   credential/social approach designed for an external session authority. Merely
   importing Better Auth crypto/OAuth helpers is not this option because it would
   make Pertexo responsible for reconstructing the surrounding lifecycle.

No option may create two concurrently valid Pertexo browser-session authorities.
Option 1 is accepted; options 2 and 3 are not selected. A1–A4 may proceed under
the implementation plan, with tested migration and cutover before runtime rollout.
ADR 004 remains authoritative for the guarantees not superseded above.

## Consequences

The gate prevents a library install from silently changing a security guarantee.
It also makes the cost of each option explicit: option 1 changes token-at-rest
policy, option 2 owns a fork, and option 3 reopens the already selected provider.
Account linking must still disable implicit same-email linking and enforce fresh,
two-sided proof at direct server endpoints. Better Auth organizations and roles do
not replace Pertexo memberships or capabilities.

### Approved closure rules (2026-09-23)

- Every account-link attempt requires an explicit fresh challenge of the
  existing sign-in method. A session's age, sliding refresh or an earlier
  successful sign-in is insufficient. The challenge authorizes only its one
  browser/session-bound linking intent and expires within five minutes. The
  added provider method requires independent fresh protocol proof.
- Identity/account-security audit facts are append-only and identity-scoped,
  including accounts with no workspace. They follow the platform's 365-day
  audit/security retention policy, subject to its legal policy. Audit metadata
  excludes credentials, bearer links, raw callbacks and provider payloads;
  workspace audit rows are not a substitute.
- A legacy broker subject is not a provider-native subject. A migration bridge
  may preserve the stable Pertexo user ID only after fresh proof of the existing
  legacy issuer/subject and fresh proof of the new sign-in method. Email alone
  never transfers ownership. If the old issuer cannot be cryptographically
  reauthenticated or mapped, require manual recovery. Generic legacy login
  remains until preflight is clean, but cannot create a second browser-session
  authority or be a production fallback after cutover.
- Better Auth 1.7.5's stateless `/verify-email` JWT does not meet Pertexo's
  single-use proof rule. Pertexo owns proof consumption and the protected
  account mutation transaction for initial verification and both email-change
  stages; a native success redirect alone is not consumption evidence.

## Evidence required before implementation is complete

- A focused executable proof for the selected session lifecycle: issue, lookup,
  refresh, list, single revoke, revoke-other, revoke-all and expiry.
- Database assertions proving the selected at-rest representation and absence of
  raw browser credentials.
- Existing role-change, invitation acceptance, workspace deletion and operator
  revocation tests against the single authority.
- Real HTTP cookie tests and SSE shutdown within ADR 004's existing bound.
- Fastify bridge tests preserving request bodies, origin checks and every
  `Set-Cookie` header.

## References

- Better Auth 1.7.5 session management and database schema documentation.
- Better Auth 1.7.5 packaged `dist/db/internal-adapter.mjs`,
  `dist/api/routes/session.mjs`, `sign-in.mjs`, `callback.mjs`, `password.mjs`,
  `account.mjs`, `update-user.mjs` and `api/dispatch.mjs`, inspected during A0.
- ADR 004 and the authentication/account-linking implementation plan.
