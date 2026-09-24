# Better Auth authentication and account linking

Status: user approved Better Auth and authorized implementation on 2026-09-22.
This revision replaces the managed-provider proposal previously in this file.
The bounded implementation is present; the external production-mail, live social-
provider and deployment-rehearsal gates recorded below remain open.

## 1. Selected architecture and scope

Use Better Auth inside Pertexo's backend, with Pertexo-designed React screens.
No Auth0 subscription, Keycloak deployment or separate identity server is required.
Pertexo operates authentication and stores library-managed password hashes.
Do not write password cryptography ourselves.

Implement email/password signup, verification/resend, login/logout, recovery/reset/change,
Google sign-in, explicit linking/unlinking, adding a password to a social account,
verified email changes, account-security settings and session management.
Include Microsoft, GitHub and Apple integration/configuration paths; enable each only
when configured and verified. Missing social secrets must not block independent
implementation or result in fake working buttons.

Pertexo retains workspace permissions, ActorContext, memberships, RLS, resource
ownership, audit and invitation semantics. Social login does not authorize workflow
nodes: workflow connections remain separate with their own consent and secrets.

Excluded: billing, automatic account merging, account/resource deletion, enterprise
SAML/SCIM, arbitrary customer-supplied issuers, API keys, MFA/passkey enrollment and
a generic provider framework. These are future slices, not implied by SDK plugins.

## 2. Baseline and ADR gate

ADR 039 is accepted: the user approved Better Auth's standard token-bearing
database sessions, replacing ADR 004's managed-provider/custom-session choice
and digest-only storage rule. Preserve ADR 004's historical text and all unaffected
authorization/security guarantees. This approval does not weaken linking, CSRF,
revocation or SSE requirements and does not mean migration is already implemented.

Inspect these existing seams before migration:

- apps/api/src/identity/oidc.ts: login transaction and identity mapping.
- apps/api/src/identity-infrastructure/oidc-adapter.ts: custom jose-based adapter.
- apps/api/src/identity/session.ts and platform identity wiring.
- packages/database/src/tenant-access/identity-workspace-identity-store.ts:
  issuer/subject mapping and transactional provisioning.
- Migration 0008: unique lowercased user email; unknown same-email identities
  currently conflict, rather than linking.
- Auth controllers/guards, current-user endpoint, invitation recipient verification,
  SSE authorization and all session revocation callers.

Pin a supported Better Auth release after checking actual Node/TypeScript/module,
Nest/Fastify and PostgreSQL compatibility. Preserve repository build and migration
tooling. This is a replacement of authentication ownership, not a second login
system layered over existing issuance.

## 3. Ownership and structure

| Responsibility | Owner |
| --- | --- |
| Passwords, verification/reset mechanisms, social protocol, authentication methods and sessions | Better Auth inside identity infrastructure |
| Stable user ID, memberships, workspace capabilities, data ownership, audit and RLS | Pertexo |
| Session-to-ActorContext mapping and fresh authorization for API/SSE | Existing identity module adapted to the new authority |
| Login and account-security presentation | React feature modules |

Use one Better Auth configuration/handler behind a small internal interface.
Keep SDK types out of domain modules and workers. Do not create a wrapper per SDK
method unless it owns real policy or translation.

Prefer auth user IDs equal to existing Pertexo user IDs if safe supported schema
mapping permits. Otherwise use an explicit immutable one-to-one mapping. Never
resolve the current user by email on each request. Establish one owner for canonical
email and verification with a synchronized application projection, not two writable
profile truths. Authentication tables are platform-scoped with least privilege;
the adapter must not gain tenant bypass rights.

Do not replace memberships with a Better Auth organization/role plugin.

## 4. One session authority and explicit compatibility proof

Target: Better Auth owns browser sessions. Existing Pertexo session interfaces
delegate validation/expiry/revocation to that authority; they do not mint another
independent session after login. PostgreSQL is the durable authority initially.
Do not add Redis session storage just because Redis exists.

Disable cookie-session caching/stateless shortcuts initially. Keep secure HttpOnly
cookies, strict trusted origins, bounded expiry, rotation and same-origin deployment.
Auth endpoints retain library origin/CSRF defenses; business mutations retain
Pertexo CSRF checks. No tokens in localStorage, logs or React state.

**Session policy approved:** use Better Auth's supported token-bearing PostgreSQL
session representation as accepted in ADR 039. Do not implement digest-only
adapter tricks, a private fork or an external-session hybrid. Treat stored tokens
as sensitive: least-privilege database/backup access, protected transport/storage,
separate signing secrets and strict redaction. Verify signed-cookie and alternate
token endpoint behavior; do not assume leaked identifiers are harmless. Prove
issuance, lookup, refresh, expiry and all revocation paths through tests.

Session UI gets non-secret record IDs and safe metadata only. Resolve and revoke
sessions server-side within the current user's scope. Never expose other-session
bearer tokens to implement a revoke button. Restrict stock endpoints if their public
output or mutations bypass the approved policy.

Inventory logout, password/security changes, user disablement, operator actions,
workspace deletion and SSE consumers. All must consult/revoke the same authority.
A valid library session cannot authorize a disabled Pertexo user.
SSE keeps fresh validation before each event, the existing five-second idle bound,
exact expiry handling and bounded cleanup under backpressure.

## 5. Identity migration, cutover and rollback

Inventory existing users/identities and active deployments without dumping personal
data. Use additive reviewed migrations and existing migration-history/readiness tests.
No edited published migrations, database resets or destructive user cleanup.

Preserve internal IDs, memberships, workflows and audit references. Import external
identities only with proven provider/issuer/subject correspondence: a broker subject
is not necessarily a Google subject. Ambiguous existing users need an explicit
verified migration/recovery path, never email-based identity reassignment.

At cutover, invalidate old sessions and clear legacy cookies; users sign in again.
Legacy auth routes stop issuing sessions. Temporary compatibility redirects can
enter the new login only; no fallback to a second authority.
Remove obsolete runtime auth code/config after all consumers migrate and tests pass.
Keep historical migrations.

Document staged deployment, backup, cutover checks and rollback restrictions.
Rollback must not resurrect revoked sessions, and old code may not understand newly
created accounts. No production deployment is authorized. Preserve local data and
other task work when running additive migrations or restarting development services.

## 6. Same-email and account-linking behavior

Email is a mutable contact attribute, not identity ownership proof. Linking adds a
method to one user; it does not merge users or transfer workspace memberships.

| Situation | Required behavior |
| --- | --- |
| New verified password/social signup | Provision once; only existing authorized onboarding/invitation grants workspace access. |
| Previously linked method | Same stable user and resources. |
| Unknown social identity, existing email | Neutral account-not-linked guidance; authenticate existing account and explicitly link. |
| Same email, verified on both sides | Still require deliberate two-sided proof. |
| Different emails, both controlled | Explicit linking may succeed; canonical contact email stays unchanged. |
| Identity already belongs to another user | Safe conflict; no reassignment or merge. |
| Missing/unverified provider email | Verified completion flow or actionable rejection, not fabricated verification. |
| Upstream email changes | Stable provider identity still resolves user; no silent canonical email replacement. |
| Cancellation/timeout/expired attempt | Existing methods unchanged; safe retry/reconciliation. |
| Removing last usable method | Reject, including concurrent requests; unverified methods do not count. |

Disable implicit linking. Verify the pinned release's
`accountLinking.disableImplicitLinking` option and test it. Do not enable trusted
provider shortcuts to bypass proof. Enforce policy server-side, including direct
calls to native library endpoints—not just through custom React forms.

Require fresh proof of the existing account within five minutes, independent fresh
authorization of the added method and explicit linking intent. Sliding session
refresh is not reauthentication. Bind single-use attempts to user, initiating
session/browser, purpose and allowlisted return destination. Reject account changes,
replay, stale proof and cross-purpose callbacks. Check provider-specific evidence;
a prompt parameter alone is not proof of fresh authentication.

Separate login, linking, invitation verification and password setup. Invitation
recipient tokens cannot authorize linking. Persist only necessary attempt state.
Serialize competing mutations and test uniqueness/last-method protection under
concurrency; a precheck or a hook is not automatically a transaction.
Use explicit reconciliation for uncertain callback outcomes, never blind identity
deletion or reassignment.

Retain unique canonical email behavior. Reconcile existing normalization differences;
do not strip Gmail dots/plus suffixes or aliases. Do not reveal another user's
methods/workspaces in errors. Rate-limit sensitive flows across replicas and verify
trusted proxy/IP handling.

## 7. Passwords, email, recovery and security changes

- Use maintained library password hashing/settings; support password managers,
  paste and correct autocomplete. Bound resource/input size without truncation.
- Require verified canonical email for ordinary workspace access. Unverified
  accounts may only use restricted verification flows, not normal authorization.
- Verification/reset links must expire, be single-use and purpose-bound, and resist
  replay/concurrent consumption. Generic recovery responses and resend limits.
- Use existing mail infrastructure with a focused auth-mail responsibility, not
  workflow nodes or invitation jobs reused indiscriminately. Delivery survives
  request completion with bounded retries. Queued bearer links/tokens are
  secret-bearing: protect payloads, bound retention and never log them.
- Password reset revokes all sessions and returns to login. Password change,
  link/unlink and verified email change revoke other sessions and rotate the
  current one. Test failure atomicity; if coordination needs transactions/outbox
  and fail-closed validation, implement it rather than assuming hooks are atomic.
- Social-only users add a password through an explicit authenticated, recently
  reverified flow and verified canonical email. Generic forgot-password must not
  unintentionally create a password method or bypass this policy.
- Email change requires reauthentication, new-address verification and appropriate
  old-address confirmation/notification. Conflicts retain the existing address.
  Invitation eligibility continues to require its own current recipient proof.
- Record safe audit events and notify verified contacts of sensitive changes.
  No password/token/verification-URL/full-callback data in logs or audit metadata.
- Avoid persisting unnecessary social tokens. If required, protect at rest through
  existing secret mechanisms, test both reads/writes and key rotation, and request
  authentication scopes only, not workflow API scopes.

## 8. Backend interfaces and frontend contracts

Mount the handler once under a deliberate same-origin prefix, preferably /v1/auth,
after resolving old route collisions. Verify the Fastify bridge preserves bodies,
headers, multiple Set-Cookie values and proxy origin. Apply request/rate limits.
Do not copy Express integration assumptions into Nest/Fastify.

Retain the Pertexo current-user endpoint as the canonical application snapshot.
Add a minimal public capability response for enabled methods/readiness—not secrets
or user lookup. Unconfigured authentication must show a safe actionable state, not
the current misleading 404/connection-interrupted experience.

Pertexo-owned current-user, capabilities, security summaries and error schemas live
in existing browser-safe shared contracts. Native auth-client details may remain
inside feature-local API adapters. Never import server configuration into React for
type inference. Keep validation, conflict, expiry, cancellation, throttling and
outage responses consistent with one visible feedback owner.

Guard all sensitive library endpoints, including alternate ones not used by our UI.
Return destinations are relative/allowlisted. Provider selection is a server
allowlist, never arbitrary user-supplied URLs/issuers.

No mandatory openid-client migration now: Better Auth owns selected social flows.
Keep/add a separate OIDC client only for a demonstrated compatibility requirement.
Enterprise OIDC remains a future slice; do not build an identity server simply to
make Better Auth look like the previous provider.

## 9. React ownership and design

Follow apps/web/AGENTS.md and ARCHITECTURE.md. Preserve the completed visual work.

- features/auth owns small signup/login/verification/resend/recovery/reset/callback
  modules, focused components, validation and API operations. Routes compose them;
  do not create a giant component with every form mode.
- features/account-security owns linked methods, linking confirmation, password
  setup/change, email change and safe session controls. This is user settings, not
  workspace role management.
- Shared primitives stay shared; feature-specific UI stays in the feature. Use
  existing visual tokens and a focused unauthenticated shell, not workspace chrome.
- TanStack Query owns application current-user/security snapshots. Contain any
  Better Auth client inside the auth API module; do not also use a reactive SDK
  session store as a competing authority. No auth Zustand store.
- Passwords stay transient in local forms and request handling; never persist them
  in URL/global stores/query data/telemetry or durable mutation caches. Clear
  sensitive state after completion/unmount. Server validation is authoritative.
- Implement clear pending/error/expired/cancelled/verification/collision states,
  single-submit handling, accessible focus and safe invitation continuation.
- Cancel identity-scoped queries and clear caches on logout/account switching.
  Refresh snapshots after security changes and handle cross-tab logout.
- Only configured providers have buttons. Supply Google/Microsoft/GitHub/Apple
  setup paths; distinguish implemented code from live-provider verification.
- Check 390/768/1024/1440 widths, keyboard, forced colors and 200% zoom. Local
  email/password must work without social secrets, using a safe local mail sink.

## 10. Implementation sequence

### A0 — Compatibility proof, ADR and contracts

Better Auth is selected; do not reopen vendor selection. Inspect the pinned release,
write the superseding ADR and exact schema/ID/session/cookie/CSRF/TTL/normalization
decisions. Prove Fastify integration, approved stock session behavior, fresh
linking controls and transactional behavior with focused tests before broad changes.
Escalate concrete unsupported invariants, not routine choices. Record evidence here.

**A0 evidence (2026-09-22): session-policy blocker resolved by user approval;
runtime integration verification remains required.** Better Auth `1.7.5` was inspected from its published package and
current official documentation. Node 24, ESM, PostgreSQL and React 19 are within
its supported ranges. The official Fastify path is a manual Fetch bridge; the
community NestJS integration labels Fastify support beta, so it is not selected
as an authorization dependency.

The published session schema stores a retrievable unique `token`. The packaged
internal adapter uses it for cookie issuance, find/update/delete, list sessions,
single revoke and revoke-other. Supported configuration and database hooks do not
provide session-token hashing at rest. A custom adapter can hash direct lookups but
cannot reconstruct tokens for native list/revoke-other behavior; exposing digests
or inventing adapter-only handles either leaks lookup material or changes
undocumented lifecycle semantics. Stateless/cookie-cache modes do not preserve
immediate durable revocation and ADR 004's SSE checks. Therefore stock Better Auth
cannot be shown to preserve digest-only session storage through a supported,
maintainable lifecycle.

The bounded hybrid-feasibility follow-up **withdrew** the initial recommendation
to retain `OpaqueSessionService` while using Better Auth only for credential and
social verification. Signup and ordinary verification can suppress automatic
sign-in, and reset consumption is sessionless, but successful password login and
social callback unconditionally create a Better Auth session. Recent-password
proof, link/unlink, password change and email change authenticate through Better
Auth session middleware. After hooks run only after the session-producing handler;
a before hook would have to replace the entire endpoint. Public password/OAuth
helpers are primitives, not a supported external-session completion interface.

An isolated assertion against the published `1.7.5` package checked password
sign-in, social callback, OAuth user completion, recent-password proof, social
linking, password change and hook ordering; all 7/7 assertions confirmed those
constraints. Discarding the Better Auth cookie and deleting its newly created
session was rejected because it still mints a hidden second session and can fail
between issuance and cleanup.

ADR 039 records the viable choices and the user's acceptance of Better Auth's
stock token-bearing representation. The digest-only policy is explicitly amended;
the private fork and external-session hybrid are rejected. A1–A4 may now proceed
under the remaining verification gates. This A0 proof itself added no runtime
dependency or second session authority; implementation progress must be recorded
separately and must not be inferred from policy approval.

**A0 implementation evidence (2026-09-22): delivered.** Better Auth `1.7.5`
is pinned in the API. An executable compatibility test now covers signup/session
issuance, signed-cookie lookup, UUID identifiers, list, single revoke,
revoke-other and revoke-all using the published lifecycle; it also proves that
the complete signed browser credential is not the token value stored by the
database adapter. The focused test passes. A separate Fastify injection test
covers JSON request bridging, explicit same-origin rejection and response cookie
forwarding. Public authentication-capability contracts and generated OpenAPI
artifacts are present.

Migration `0101_better_auth_foundation.sql` is additive: `app.users` remains the
stable Pertexo identity row, while Better Auth receives dedicated account,
session and verification tables in the `app` schema; the migration invalidates
legacy opaque sessions at cutover. The configuration maps generated IDs to UUIDs,
disables cookie caching, disables implicit linking, encrypts persisted OAuth
tokens, checks active-user status before session creation, and disables native
session/account-security endpoints that would expose token-shaped identifiers or
bypass Pertexo policy. The handler is mounted through the owned Fastify Fetch
bridge. Real PostgreSQL tests prove the exact signed-cookie boundary, stable UUID
user identity, token-bearing database representation, runtime-role isolation and
the custom token-free session-management endpoints. Generated contracts and
OpenAPI remain the browser-safe public seam.

### A1 — Backend foundation and cutover

Implement migrations, authentication module and single session authority. Update
guards, current-user, logout, revocation consumers and SSE together. Wire capability
and readiness/error states. Prove tenant isolation and invitation/deletion behavior.
Do not enable partially migrated competing session systems.

### A2 — Email/password end to end

Implement custom React signup/login/verification/resend/recovery/reset/change and
local auth-mail setup. Test real frontend/API/database, invalid/expired/replayed
links and failure handling. No destructive resets, paid purchases or production
secrets committed.

### A3 — Social methods, linking and security settings

Implement Google then other configured methods, guarded link/unlink, password
setup, email change and session list/revoke. Prove stable user IDs and race handling.
If credentials are absent, finish safe code/configuration and fixture tests; report
real-provider validation as pending. Do not claim fixtures prove provider consent.

### A4 — Verification and cleanup

Run affected checks, browser validation and migrations/cutover tests. Document exact
local URLs/env names, social client registration callbacks, email setup, upgrades,
secret rotation, backups and rollback. Remove obsolete runtime auth only once its
replacement is proven. Update contradictory architecture/operations docs, not
historical checkpoint claims. Preserve published migrations and unrelated work.

**A1–A4 delivery evidence (2026-09-22): partial implementation; linking,
legacy identity recovery and external gates remain open.** Better Auth is the
browser-session authority behind the existing
`OpaqueSessionService` interface. Additive migrations create authentication
method/session/verification storage, revoke legacy sessions at cutover, revoke
the new sessions on user or workspace unavailability, and expose bounded expired-
session pruning through the existing retention worker. Password signup,
verification, login, recovery/reset/change/setup, verified email change,
configured social sign-in, fail-closed unproven linking, transactional last-method protection and
token-free session list/revoke are wired to feature-owned React screens.

Real disposable-PostgreSQL tests cover verification, sign-in, exact cookie and
stored-token behavior, password rotation, email-change confirmation, unlink
protection, user/workspace lifecycle revocation, retention and worker-role denial.
Unit/component suites cover the Fastify bridge, public contracts, routed auth
screens, CSRF-bearing security mutations and StrictMode. Mocked Chromium covers
email/password entry, logout, narrow/reduced-motion login and account-security
layout. At this evidence point the full API unit suite passes 1,335 tests, the
web unit suite passes 228 tests, the contracts suite passes 74 tests, the
database unit suite passes 768 tests, the disposable-PostgreSQL database suite
passes 567 tests across 85 files, and mocked Chromium passes all 44 journeys.
The API integration command ran the three Better Auth PostgreSQL cases and
skipped 67 environment-gated cases across nine suites. Database readiness and
prior-head fixtures now recognize `0102_better_auth_session_lifecycle.sql` as
the serving head; schema ownership reports 79 tables (60 typed and 19 raw SQL).
React Doctor reported 28 diagnostics, all outside the new authentication and
account-security source; they remain diagnostics rather than completion proof.

The slice is not production-qualified yet. No Google/Microsoft/GitHub/Apple
credentials were available, so real provider consent/callback behavior remains
unverified. `AUTH_MAIL_MODE=local` is an in-memory development/test sink and
`disabled` fails closed; a durable production auth-mail delivery adapter with
retry/operations evidence is still required before deployment. The retained
purpose-bound invitation OIDC proof path now delivers Better Auth sessions but
has not yet been removed as a general compatibility route. Live full-stack
browser/API/database provider journeys, cross-browser coverage and deployment
cutover/rollback rehearsal remain open gates; mocked Chromium and fixture tests
do not satisfy them.

Implementation is authorized across A0–A4. Continue through safe unblocked work, not
just scaffolding. No commit/push/merge, paid service, external account creation or
production deployment is authorized. Report required external credentials securely.

## 11. Acceptance matrix

- Password: verification gating, generic credential/recovery errors, limits,
  reset/verification replay/expiry, resend throttling and delivery failure.
- Social: provider-specific protocol validation, state/PKCE/nonce as applicable,
  wrong issuer/audience, browser mismatch, replay, cancellation, safe redirects,
  malformed/oversized/time-out responses and no secret leakage.
- Database: concurrent first logins, email conflict without orphan records,
  immutable identity ownership, stable user migration and actual-runtime-role RLS.
- Linking: raw endpoint bypass attempts, same-email non-link, both proofs, stale
  proofs, different emails, owned identities, user/session switch, parallel unlink
  and last usable method.
- Sessions: approved token storage and refresh behavior, rotation/expiry, token-free
  list/revoke, reset/security-change invalidation, disabled users, workspace
  deletion, SSE per-event/idle checks and absence of stale-cache authorization.
- Invitations: preserved purpose-bound recipient verification, safe return,
  wrong recipient, expired/revoked intent and duplicate acceptance.
- Browser: real web/API/database email flows, real social provider when configured,
  fixture hostile cases, mobile/zoom/keyboard/forced colors, multi-tab/back navigation,
  password managers and account-switch cache cleanup.
- Applicable build/lint/typecheck/unit/API/database/architecture/browser suites
  and React Doctor. Report actual commands/results and external limits, not just a score.

## 12. Handoff

### Independent closure review — 2026-09-23

The earlier delivery counts are implementation-task reports, not final acceptance.
Independent review and live testing found outstanding defects; release/merge is
gated on their resolution and verification. Track closure here rather than adding
another audit file.

#### Approved durable authentication-mail seam (2026-09-23)

Authentication mail is identity-scoped and must not be forced through the
workspace-scoped workflow/invitation outbox. Before adding schema, record an ADR
that approves a dedicated `AuthenticationMail` adapter backed by a small durable
store interface: enqueue one encrypted message and return only after PostgreSQL
commits it. The persisted command contains purpose, recipient, expiry and a
sealed payload (display name, destination URL and optional new email); raw bearer
URLs never enter logs, queue JSON or provider metadata. API runtime receives only
enqueue permission. A worker-owned delivery adapter claims bounded batches with
leases, decrypts only while dispatching, uses a stable per-message provider
idempotency key, and records submitted, terminal-rejected or outcome-unknown
states. Unknown outcomes retain the same sealed command for bounded exact retry;
terminal/expired records clear ciphertext. Maintenance deletes terminal metadata
after the documented receipt window and expires abandoned queued commands while
preserving legal holds if authentication evidence becomes hold-eligible.

The seam deliberately reuses the existing application-owned Resend HTTP adapter
and envelope primitive, but not invitation rows, tenant RLS context, workflow
credentials or a dummy workspace. Configuration must fail closed in deployed
environments unless API encryption and worker provider/decryption settings agree
on an active key version. Verification must include API-role denial of reads,
worker-role denial of enqueues, encryption-at-rest inspection, crash points before
and after provider dispatch, exact retry/idempotency, expiry/retention and a fake
provider. No real external message is sent without separate authorization.

Design review approves this narrowly scoped seam for implementation under the
existing authorization. Record its ADR before schema/runtime changes; approval
is not evidence of implementation or production qualification. Additional rules:

- Encrypt the complete delivery payload, including recipient and immutable
  subject/body or all version-pinned rendering inputs. Bind purpose, message ID
  and expiry to authenticated encryption. Avoid unnecessary plaintext personal
  data; routing requires no plaintext recipient in the queue.
- A claimed attempt keeps the same provider key and exact request bytes across
  retries, including configuration/template changes. Lease generations fence
  stale workers when settling results. Unknown outcomes are not terminal merely
  because a provider returned a structured 5xx response.
- Bound dispatch by the underlying token's validity and the provider's documented
  idempotency window. Do not resend an ambiguous attempt after that window or
  silently mint a replacement token; preserve a safe reconciliation state and
  expire unusable payloads. No exactly-once delivery claim.
- Commit enqueue before acknowledging acceptance; define failure behavior when
  token issuance and mail enqueue do not share a transaction. A failed request
  must not claim successful delivery. Resend attempts must remain throttled and
  must not authorize account changes before verification.
- Prefer narrow database functions/privileges over broad table access; worker
  permissions must not disclose credential/session tables or bypass tenant RLS.
  Test lease concurrency, crash recovery and denial with actual runtime roles.
- Pin sender/provider identity for an attempt, support explicitly configured
  decryption key rotation, and fail closed on missing required keys. Health checks
  must distinguish local configuration validity from actual remote delivery.
- Set concrete bounded retention/retry/batch limits in the ADR. Reuse existing
  retention requirements where applicable; do not introduce a speculative legal-
  hold subsystem or general messaging framework for this slice.

The local in-memory sink remains development/test-only. Production credentials,
verified sender/domain setup and real external delivery remain separate gates.

- [x] Standalone Better Auth startup: configuration and runtime composition no
  longer require the optional legacy OIDC provider/transaction block. The local
  example now supplies `PUBLIC_WEB_ORIGIN`; focused config, runtime and full API
  tests pass without fake OIDC values.
- [x] Recovery endpoint: the browser now uses Better Auth 1.7.5's
  `/v1/auth/request-password-reset` route. A request-builder test and a real
  mounted Better Auth/Fastify handler test cover the exact path.
- [x] Native auth response/endpoint surface: the mounted Fastify boundary strips
  token/access-token/refresh-token/ID-token fields from the native responses the
  browser uses and returns nondisclosing 404 responses for get-session,
  access/refresh-token, account-info/list and update-session routes. Fastify
  injection verifies the handler is never reached for blocked paths.
- [ ] Prove fresh, purpose-bound two-sided linking, callback session rotation,
  and safe direct-endpoint behavior against a configured external provider; do
  not infer live consent from local provider fixtures.
  Review of Better Auth 1.7.5's actual `/link-social` and OAuth callback found
  that session age is not existing-method reauthentication, and callback link
  state is not bound to the initiating browser session. Native linking remains
  fail-closed. Additive migration 0106 and an owned linking callback now bind
  the attempt to the current user, session, browser, state, source method and
  target provider for five minutes. Password or linked-provider source proof
  and independent target-provider proof precede a transactional account attach,
  identity-scoped audit and session rotation. Account security advertises only
  configured providers. The real-PostgreSQL mounted-handler fixture proves a
  wrong password/browser is rejected, concurrent callbacks have one winner,
  replay does not attach again, and password- and social-source journeys rotate
  the session. This is local protocol evidence, not a live configured-provider
  callback or production consent qualification.
  The user has now approved a fresh existing-method challenge for every one
  linking attempt, expiring within five minutes; a recent sign-in and session
  age do not count. Identity-scoped append-only security audit follows the
  existing 365-day policy, including users without a workspace. ADR 039 records
  these choices. Do not substitute session age or native `/link-social` for the
  owned protocol.
- [ ] Close legacy generic-login/migration ambiguity and failure-atomic security
  changes with focused evidence. The native Better Auth Fastify boundary now
  uses the application's distributed identity-start/callback rate-limit
  consumer and fails closed when it is unavailable; mounted Fastify tests
  cover allowed, limited and unavailable requests. This does not resolve the
  legacy identity mapping. Password change/setup now commit credential mutation
  and session revocation in one PostgreSQL transaction; a forced deletion
  failure rolls back the password, and competing setup commands create one
  credential. The stock reset mutation is blocked: the owned reset endpoint
  consumes a proof, changes an **existing** password method and revokes
  sessions in one transaction. Disposable-PostgreSQL tests cover rollback,
  concurrent single-use reset, replay and a social-only account that receives
  no reset mail or new credential. Additive migration 0104 revokes sessions
  transactionally on a canonical email change, with API-role commit/rollback
  tests. Library social-link callback/credential hooks still require their
  own atomicity proof before linking is enabled. A read-only
  `pnpm --filter @pertexo/database auth:cutover:preflight` command now reports
  only aggregate counts of active users without native methods, active legacy
  identity users lacking a verified native-method bridge, and live legacy
  sessions; any nonzero count fails closed. The
  prior-head disposable-PostgreSQL rehearsal demonstrates the legacy-user
  block after applying 0101–0104. The user has approved a purpose-bound bridge
  requiring fresh cryptographic proof of the old issuer/subject and a new
  method, with manual recovery when the old issuer cannot prove ownership;
  email matching is forbidden. Additive migration 0107 and the owned browser-
  bound bridge now require exact old issuer/subject proof followed by a new
  provider proof; the atomic attach records a durable migration marker, audit
  and session rotation. Generic old OIDC login is disabled in Better Auth mode
  before identity mapping, while invitation-purpose OIDC remains available.
  A real-PostgreSQL mounted-handler fixture proves stable user identity,
  wrong-browser rejection and concurrent single-use completion; a focused
  OIDC test proves stale generic callbacks cannot map identities after cutover.
  Live old/new providers, manual-review operations and production rollback are
  still unqualified. The inventory cannot prove subject ownership on its own.
- [ ] Frontend closure: resumable verification/resend, linking outcome feedback,
  auth-loss/account-switch cache cleanup, capabilities on direct routes,
  confirmations, precise error mapping and obsolete mutation-error cleanup.
  Route tests now cover auth-loss/account-switch Query cache cleanup and link
  return feedback. Component and mocked Chromium tests cover explicit method
  and session-removal confirmation, including cancellation before any command.
  Broader verification/callback recovery and remaining direct-route error
  paths still require closure.
  Follow-up routed tests now cover verification resend after reload without
  resubmitting credentials, password-method capability gating on direct signup
  and recovery routes, reset-token route changes, stale provider redirects,
  distinct rejected versus uncertain reset outcomes and account-link callback
  disposal. Mocked Chromium covers resend after reload. Native Better Auth
  errors are translated at Fastify into contract-valid nondisclosing problem
  details with request IDs; the UI distinguishes verification, throttling,
  transport uncertainty and invalid reset proof. Other route/error journeys
  and complete live browser/API evidence remain open. Additional mocked
  Chromium journeys cover capability outage/retry and distinguish a definitely
  invalid reset link from a lost completion response. A stale linking-return
  notice no longer promises a retry button while linking is disabled. Resend
  success is now a status announcement rather than a field error; routed and
  mocked-Chromium tests cover this distinction. Live browser-to-API provider
  callbacks and cross-browser accessibility remain open.
- [ ] Durable production auth mail and isolated cutover/rollback rehearsal. A
  real disposable-PostgreSQL rehearsal now proves the 0100→0101→0102 migration,
  stable user/legacy-identity preservation, legacy-session revocation and
  idempotent rerun. It also makes the remaining rollback prerequisite explicit:
  legacy identities do not acquire Better Auth accounts automatically, so a
  standalone deployment still needs an approved recovery/mapping policy. The
  dedicated ADR 040 mail seam now has a sealed PostgreSQL command, API enqueue,
  worker claim/lease/delivery and bounded cleanup through migration 0103.
  Disposable-PostgreSQL tests inspect ciphertext at rest, key rotation and
  bounded retention; fake-provider tests cover exact-key retry, rate limits
  and expiry. The ECS manifest now injects one shared Secrets Manager key and
  one shared SSM key-version reference into both API and worker, enables
  durable mail/delivery in deployed tasks, and validates the rendered parsers.
  A cross-process local seal/open probe succeeds with matching keys and fails
  with a same-version wrong key. Deployed worker config rejects disabled mail;
  a failed delivery cycle now makes worker readiness fail until a successful
  cycle. The fake provider test decrypts a real sealed command before asserting
  exact request bytes/key across an uncertain retry. A controlled real-PG
  worker integration now runs API-role enqueue -> worker-role claim/decrypt ->
  fake-provider submission -> settled ciphertext cleanup. The prior-head real-PG
  rehearsal now asserts 0103 enqueue and 0104 canonical-email revocation after
  the additive upgrade. Production qualification remains open: shared secret
  references do not prove running tasks received the same rotated value, and
  sender/provider provisioning, live delivery, approved legacy recovery and
  cutover/rollback rehearsal have not been demonstrated. No real message was sent.
- [ ] Real configured social-provider callbacks and full cross-browser evidence.

**Owned email-proof correction (2026-09-23):** Better Auth 1.7.5's stateless
verification JWT was confirmed to replay as a success redirect. Additive
migration 0105 now owns digest-only, purpose-bound, expiring proof rows and
identity-scoped security-audit facts. The mounted auth handler emits only owned
proof links, rejects native verification tokens, and consumes initial and both
email-change stages transactionally. Durable mail is sealed and enqueued in
the proof transaction; local mail remains test/development only. Successful
consumption redirects to a fixed application destination, while replay/expiry
is reported as invalid. Disposable-PostgreSQL HTTP tests now pass the
previously red replay assertion, concurrent clicks, expiry, both email-change
stages, durable sealed-mail issuance, enqueue failure rollback, revocation
rollback and runtime-role denial. Retention tests cover bounded proof cleanup
and 365-day audit cleanup with legal hold. Password change/setup/reset and
method removal now write safe identity-scoped audit facts in their mutation
transaction. This closes the confirmed replay
defect; it does not imply provider-linking, legacy migration or external mail
qualification is complete.

Current local verification (2026-09-23): disposable-PostgreSQL database
integration passed (87 files/571 tests), including sealed-mail, key-rotation
and prior-head cutover checks; database unit tests passed (114 files/769 tests).
The focused Better Auth/PostgreSQL suite passed (13/13), including
transactional reset and email-change rollback. API and worker unit suites
passed (102 files/1,347 tests and 62 files/763 tests). A concurrent multi-suite run exceeded two API
shutdown test deadlines and missed one web UI wait; serial reruns passed the
full API and web suites. Web unit/component tests passed (26 files/242 tests),
as did web/API/worker/database builds, all four package typechecks and mocked
Chromium journeys (49/49). The new worker-mail integration passed against real
disposable PostgreSQL and a fake provider (1/1). The API integration runner
initially found the replay defect; its focused mounted PostgreSQL suite now
passes 13/13. The prior separate integration run skipped nine environment-gated
suites (67 tests). Contracts tests passed (16 files/74 tests); the artifact check,
architecture checks (19/19), schema validation (5/5), deployment checks
(60/60), root lint and `git diff --check` passed. Focused formatting of the touched
authentication files passed; repository-wide `format:check` remains red on
other dirty files and is not claimed as a pass. The contracts linter emitted
one non-blocking `operation-2xx-response` warning. No configured social-
provider callback, real authentication email, or production cutover was
exercised. React Doctor (untracked files included, score and uploads disabled)
reported 42 diagnostics in changed scope, including 13 in auth files; triage
found no confirmed new defect in those auth warnings. These are diagnostics,
not evidence of acceptance or a passing quality gate.

Local linking/migration update (2026-09-24): additive migrations 0106 and 0107
passed the full disposable-PostgreSQL database suite (87 files/573 tests). The
mounted Better Auth/PostgreSQL fixture suite passed 15/15, including one-winner
linking and old-issuer/new-provider migration; these use deterministic provider
fixtures, not external consent. API unit tests passed 102 files/1,348 tests;
web unit tests passed 26 files/243 tests, including the pre-session migration
request regression. The web
build/typecheck, root build, contract generation/check, schema ownership and
architecture checks passed. Contracts unit tests passed 74/74, database unit
tests 769/769, retention unit tests 100/100 and worker unit tests 763/763.
Root typecheck passed. Mocked Chromium journeys passed 51/51, including
two new cases for the linking challenge and migration-start failure. The latter
caught and fixed a missing pre-session
CSRF exemption in the actual frontend request builder. No live provider,
production email, migration rollback rehearsal or controlled multi-browser
provider callback was exercised. Repository-wide lint and `git diff --check`
passed after fixing the new auth fixture diagnostics. Documentation checks
passed (21/21, 135 links). React Doctor with untracked
files, score/telemetry and supply-chain upload disabled reported 45 warnings,
zero errors; the two new auth loading-state warnings point to cleanup already
inside guarded `finally` blocks, not confirmed defects.

Remaining acceptance cases are specific, not implied passes:

- Password verification: owned initial and two-stage email-change proofs have
  mounted one-time/replay tests, including expiry, concurrent consumption,
  durable queueing and rollback. Reset consumption/rollback and session
  revocation have separate real-PG coverage. Frontend status notices have
  routed tests; browser-to-live-API delivery remains unverified.
- Social/linking: an owned two-sided protocol, browser/session binding,
  transactional attach, audit and rotation now have real-PostgreSQL fixture
  coverage. No configured external provider, live consent callback or
  cross-browser provider run has been exercised; the fixture cannot qualify
  provider-specific issuer/nonce behavior.
- Cutover: the aggregate preflight fails safely for an unmapped legacy user;
  an owned exact-issuer/subject bridge has real-PostgreSQL fixture coverage and
  generic legacy login is disabled before mapping in Better Auth mode.
  Provider-backed migration, manual recovery operations and production
  backup/rollback rehearsal remain open.
- Delivery/runtime: API-role enqueue, worker-role settlement, ciphertext
  cleanup and a fake provider ran against disposable PostgreSQL. Verified
  sender/domain, provider credentials, external delivery, multi-task rotated
  secret parity and actual production readiness remain untested.
- Browser: new mocked Chromium recovery/resend journeys pass, and an earlier
  isolated browser/API flow used legacy configuration placeholders. A normal
  startup full browser/API/database flow, Firefox/WebKit, provider consent,
  zoom/forced-colors and cross-tab social callback journeys have not run.

Parent-controlled live evidence against an isolated migrated PostgreSQL database
(no development data changed): browser signup, local verification-link consumption
over HTTP, browser login, no-workspace access state, account-security read and
logout succeeded. A live HTTP reset probe returned reset 200, replay 400,
old-session current-user 401 and new-password login 200. These checks used a
temporary test harness with legacy configuration placeholders to get past the
startup defect; they do not qualify the normal setup or production delivery.
Responsive browser inspection was attempted, but the in-app browser's CSS width
did not match the requested override, so exact-width/cross-browser acceptance is
not claimed. Native tokens were checked by field presence without logging values.

Task: Review apps web codebase, ID 01a0a09e-2fed-7061-99c2-e1a5412561e7.
Its bounded frontend correction pass is finished. Preserve its uncommitted visual
and invitation changes; implement this plan next without unrelated redesign.

Start A0 and record the ADR before implementation, then continue A1–A4 where gates
pass. Return progress/completion to the planning task with behavior, evidence,
remaining setup and concrete blockers. Do not silently weaken invariants, switch
providers or create redundant audit documents.

## References

- [Better Auth account management](https://better-auth.com/docs/concepts/users-accounts):
  linking controls; verify against the pinned release.
- [Better Auth sessions](https://better-auth.com/docs/concepts/session-management):
  storage and caching semantics.
- [Better Auth PostgreSQL](https://better-auth.com/docs/adapters/postgresql).
- [Better Auth email/password](https://better-auth.com/docs/authentication/email-password).
- [ADR 004](adr/004-managed-oidc-and-internal-authorization.md): existing constraints.
- [ADR 039](adr/039-better-auth-and-session-authority.md): A0 compatibility
  findings and the accepted browser-session policy decision.
- [OWASP authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
  and [recovery](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
