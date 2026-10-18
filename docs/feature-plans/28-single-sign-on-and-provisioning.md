# F28 — Single sign-on and provisioning

Status: social and organization OIDC merged; SAML qualified; SCIM next. Updated: 2026-10-18.
Parent: [roadmap](../product-roadmap.md). Decision: [ADR 086](../adr/086-federated-sign-in-and-provisioning.md).

## Current code

Better Auth 1.7.7 owns every browser session. Google/GitHub credentials already
configure social sign-in per install, absent/off by default; capability discovery
and the sign-in buttons already follow that configuration. There is no instance
administrator role or global settings page. Keep instance configuration in the
existing environment settings rather than creating another administration system.

Social sign-in and verified-email-only linking are merged in [#344](https://github.com/vigani1/pertexo/pull/344), under ADR 086. Migration 0032 owns the single-use social journey. The organization slice builds on this path. Inspection of the pinned native social callback
found that existing-account attachment is not transactional with post-creation
hooks. Use the existing configured-provider proof gateway and a short Pertexo
identity transaction, as purpose-bound linking already does. Explicit linking from
account settings retains its two-sided, browser-bound proof. Native arbitrary
linking endpoints remain closed.

The organization slice adds identity organizations, verified domains, encrypted
OIDC providers, scoped JIT and required-SSO session proofs in migration 0033.
SAML and SCIM remain the next slices. The reset removed the legacy OIDC session bridge; do not restore it.
Existing identity commands already own workspace-first locks, membership revisions,
removed-member cleanup, immediate session revocation and audit. F18 audit and
publication review are merged (#342, #343). F27 already owns notices and mail.

## Decisions and rules

### Authority and configuration

- Better Auth remains the only browser-session authority. Federation verifies an
  identity, then uses the existing transactional Better Auth row/session-delivery
  pattern. No second session cookie, authentication broker or identity service.
- An **identity organization** groups explicitly linked workspaces under a control
  workspace. Its current owner manages federation. This uses `workspace:manage`,
  not a new organization role. Admins may read safe configuration/status and audit;
  changing an authentication boundary requires the owner.
- Creating the organization requires control-workspace ownership. Linking another
  workspace requires current ownership of both; a workspace belongs to at most one
  identity organization. Linking delegates its directory-managed membership policy
  to the control workspace. Show that delegation before confirmation.
- Initial bounds: 10 workspaces, 20 domains and 10 providers per organization.
  No billing, instance user administration or extra global role. Google/GitHub
  application credentials remain operator environment settings, off when absent.
  These are deployment settings; application configuration changes have audit facts.
- Store organization/domain/provider/directory commands in the identity area.
  Workspace data keeps forced RLS; the small global identity registry is an
  authentication catalog, like existing accounts/sessions. Every management
  command proves current control-workspace ownership under lock. Never grant
  ordinary clients a new cross-workspace database role.

### Sign-in and domain ownership

- Social sign-in links only when both the incoming provider email and existing
  local email are verified and equal after the existing email normalization.
  Do not force-trust a provider that reports an unverified address; never change
  the local account's email during a link. Provider verification happens before
  acquiring a database connection. Account attachment, audit, prior-session
  revocation, one new Better Auth session and single-use journey consumption then
  commit together. Native implicit linking/callbacks remain closed; the social
  callback uses the same provider verifier as explicit linking. Preserve configured
  Microsoft/Apple support through that same path, without adding new providers.
  Apple form POST callbacks land through a bounded 32 KiB URL-encoded transport
  and a same-origin 303 GET before ordinary cookie-bound proof verification.
  Front-channel tokens/profile data are ignored; session cookies stay Lax.
- Prove exact-domain ownership with a random DNS TXT challenge before claiming it.
  Normalize to ASCII/lowercase; do not inherit parent/subdomain claims. Only one
  organization can hold a verified domain on an install. Pending challenges expire
  after seven days; issuing another invalidates the previous one. DNS I/O happens
  outside the transaction; consumption rechecks challenge, expiry and revision.
  Do not add periodic DNS polling or a new background job.
- OIDC first: authorization code + S256 PKCE, state and nonce; issuer, audience,
  signature, expiry and subject validation. Identity is issuer + subject, never
  a profile field. Google Workspace, Entra ID, Okta and generic public HTTPS OIDC
  issuers use the same implementation; vendor names are setup guidance.
- SAML next: SP-initiated HTTP Redirect request / HTTP POST response. Require
  request correlation, single-use state, signed response and assertion, the pinned
  IdP certificate, issuer, audience, recipient/destination and bounded timestamps.
  Refuse unsolicited IdP-initiated login and obsolete signature/digest algorithms.
  Maximum assertion age is five minutes with at most two minutes of clock skew.
  No SAML logout protocol, encrypted assertions or signed SP requests in this slice;
  document the corresponding IdP setup. These do not weaken incoming verification.
- Single-server Caddy routes `/v1/auth/*` directly to the API under its existing
  URI/header redaction, so authorization codes, state and email-proof tokens never
  reach nginx request/error logs. Extend the existing cached-image proxy probe;
  keep its API-down privacy and signed-cookie forwarding checks.
- Both protocols bind the initiating browser and the exact provider revision.
  Journeys expire after five minutes; proof rows become eligible for the existing
  retention sweep a day after expiry. They are consumed once in PostgreSQL, across
  API instances. SAML's cross-site POST needs an explicitly Secure, SameSite=None
  purpose cookie on HTTPS; keep the ordinary session cookie unchanged. A missing
  or mismatched binding fails. Local SAML qualification uses HTTPS and a different IdP site.
- Use maintained protocol libraries behind a small proof gateway: pinned
  `openid-client` and `@node-saml/node-saml`. Route OIDC server fetches through the
  existing secure HTTP client (DNS/address checks, bounded bodies/time, no redirects).
  Initial generic issuers are public HTTPS; private-network IdP access is later.
  Do not implement JWT/XML signature validation or fork Better Auth's lifecycle.
- `Require SSO for this domain` is optional and off by default. Enabling requires
  verified ownership, a configured provider and a successful test sign-in, plus a
  working recovery owner credential. Enforce it on both session issuance and every
  session lookup; a social/password session cannot count as organization SSO.
  Configuration/enforcement changes revoke affected sessions. Password reset or
  provider linking cannot bypass the same rule.
- The control workspace's current owner is the protected break-glass account.
  It keeps a verified password sign-in, with the existing rate limits, credential
  policy and immediate session checks. Audit recovery sign-ins. While enforced,
  refuse removing that password or transferring ownership to someone without a
  verified password credential. Directory provisioning cannot manage/remove the
  owner. No hidden shared recovery password or new recovery-token subsystem.
- Provider secrets use the existing versioned application-secret envelope, with
  provider/purpose associated data and a dedicated configured key ring. Reuse key
  validation and secret generation/recovery documentation. Never persist plaintext
  client secrets, OAuth tokens or SAML responses in configuration, logs or audits.

### Membership and provisioning

- JIT is opt-in per provider, with a per-linked-workspace default role (viewer by
  default). Grant existing roles only; never grant owner. Existing manual access
  remains manual unless explicitly brought under directory management.
- SCIM 2.0 supports Users and Groups: discovery, bounded pagination/filtering,
  create/read/replace/patch/delete, active=false, and group membership changes.
  Use a standards parser (`scimmy`, no router framework) for schemas, filters and
  PATCH semantics. Pertexo owns persistence and applies each write in one existing
  PostgreSQL transaction, including membership changes and session revocation.
  The Better Auth SCIM plugin's adapter transaction cannot use the existing
  PostgreSQL membership/RLS owner directly; do not add a second membership path.
- Provisioning credentials are random, organization-scoped bearer tokens, shown
  once and stored as digests. Owners may rotate/revoke them; cap active credentials
  at five. Authenticate and rate-limit every protocol endpoint, including discovery.
  Use `application/scim+json` with bounded JSON, never browser cookies/CSRF as a
  provisioning credential. Keep protocol errors safe and standards-shaped.
- A directory assertion alone never transfers an existing account by email.
  Directory records have stable IDs; existing users bind after a verified SSO
  proof. New provisioned accounts start without credentials or verified email.
  SSO binds the immutable provider subject and directory record atomically.
  Conflicting identities fail visibly. Inactive directory records prevent JIT
  from recreating removed access.
- Group mappings reference stable group IDs and existing workspace roles. They
  have explicit priority: first matching mapping wins, otherwise the configured
  default applies. Builder and operator are incomparable; do not fabricate a
  highest role or union their capabilities. Owners never come from a mapping.
- Directory-managed memberships follow the directory. Show their source; refuse
  ordinary manual role changes with a clear direction to the mapping/provider.
  Other manual memberships and other organizations remain independent. Removal
  uses the existing removed-member cleanup, role revisions, session revocation
  and safe audit facts in the same transaction. Do not globally suspend a person
  merely because one organization removed them.
- Bound resources and fan-out: at most 5,000 directory users, 200 groups, 500 members
  per group, 100 PATCH operations and a 1 MiB request. Page size is at most 100.
  Reject oversized changes atomically. Measure the maximum changed-role projection
  before declaring these bounds qualified; lower a bound if evidence requires it.
- Metadata audits cover configuration, verification/enforcement, sign-ins/linking,
  JIT, tokens, directory resources, mappings and deprovisioning. No secrets, bearer
  material, claims/assertions, passwords or arbitrary provider messages. Pending
  proof content expires; identity configuration and directory records are removed
  with their organization. Unlinking/purging a workspace removes its managed grants
  and mappings without deleting unrelated accounts or memberships.

## Ownership and delivery

1. **Social sign-in:** extract shared browser-proof primitives in a move-only
   commit; add the bounded single-use sign-in journey and verified identity
   transaction, reuse configured Better Auth provider verification/session delivery,
   verify install configuration/discovery/buttons, document callbacks and setup.
2. **Organization OIDC:** identity persistence, DNS ownership, encrypted provider
   configuration, browser-bound OIDC proof, JIT/enforcement/recovery, guarded API
   contracts and the workspace Security page. Reuse account/session authority.
3. **SAML:** extend the same provider/journey owner with the verified SAML gateway,
   metadata/configuration UI and cross-site callback handling. No general origin
   exception for authentication POSTs.
4. **Provisioning:** SCIM protocol adapter and token/mapping commands, atomic
   existing-membership projection, management UI and operator/user guides.

Each slice gets a PR. Moves/extractions are separate commits. Plans are not a gate
for owner approval under the current request; record recommended decisions here and
continue. Finish F28 before F17. No new service, database role, queue or CI job.

API `authentication/federation` owns protocol orchestration; database
`identity/federation` owns durable commands and identity/workspace transaction
composition. Contracts own application settings boundaries; SCIM's parser owns its
protocol boundary. Web feature-local settings, queries and forms compose the public
contracts. Keep folders below roughly ten files, grouped by sub-area then role.

## Organization OIDC implementation decisions (2026-10-18)

- `authentication/federation` owns settings, protocol gateways and browser journeys,
  with management/protocol/journey sub-areas. Its Nest settings module composes the
  existing workspace authorization and admission modules. Database
  `identity/federation` owns organization/domain/provider transactions through the
  existing `/tenant-access` entry. No extra pool, session authority or database role.
- Instance `AUTH_FEDERATION_KEY`, `_KEY_VERSION` and `_PREVIOUS_KEYS` reuse the
  application key ring/envelope. Absent keys leave organization configuration off
  with an explicit setup reason. Configured stored secrets require the matching
  keys at startup. Extend the existing secrets generator and private API env file.
- Generic OIDC uses the pinned library's explicit `enableNonRepudiationChecks`,
  expected state/nonce, S256 verifier and exact redirect URI. The SDK's code flow
  otherwise relies on TLS for token authenticity; our acceptance requires JWS
  signature validation too. Select supported basic/post client authentication
  from discovery; use the existing bounded secure HTTP transport.
- Organization IdPs are authoritative only for their exact verified DNS domains.
  Require a scalar email claim (default `email`); reject explicit
  `email_verified=false`. An absent `email_verified` claim is allowed for organization OIDC, where
  the signed configured issuer and verified domain are the authority (Entra often
  omits it). Social sign-in keeps its stricter verified-email rule.
- Provider issuer is immutable; use a new provider for a new issuer. The stable
  provider UUID is the account provider identity, and the protocol subject is the
  account ID. Provider changes invalidate readiness checks and revoke its sessions.
  A required domain must retain another current, tested enabled provider before
  that change, or enforcement must first be turned off.
- Keep the existing 16-method account response bound as the attachment bound too,
  under the user's lock. Organization methods show their configured provider name.
  Explicit social linking keeps its existing password/social source proof; a person
  with only organization SSO can first add a password. Required SSO still governs
  password/social sign-in, except for the protected recovery owner.
- A provider test uses the real protocol but keeps the initiating owner's session:
  it grants no identity or membership. Bind it to that owner/session, browser and
  provider revision. Readiness belongs to a verified domain/provider revision;
  enabling enforcement needs a successful current test and a verified owner password.
  Enforced domains govern account sign-in across the install; linked workspaces
  govern JIT membership, rather than limiting identity policy to those workspaces.
- Persist session authentication method and organization provider/revision proof.
  One TypeScript eligibility owner checks creation, delivery, lookup and owned
  native account endpoints. Invitation acceptance, password/method maintenance and explicit method linking must
  preserve the verified source session's proof when replacing sessions; never
  silently turn an SSO session into a password session. Expired/revoked source
  proof requires fresh sign-in before an invitation can grant access. Reading a
  bound invitation with a revoked proof returns it to verification, so a fresh
  sign-in binds its replacement session before acceptance.
- A recovery exception belongs only to the owner of the organization enforcing
  the account's domain. Owning an unrelated workspace/organization cannot bypass
  another domain's policy. Recovery authorization is audited before use. Keep
  current credential-removal and ownership-transfer fences in their transactions.
- Enforced non-owner accounts cannot change their primary email out of the
  policy through the ordinary email-change journey; recheck at final consumption,
  including journeys started before enforcement. Password reset and provider
  attachment cannot bypass enforcement. An organization-only account must add
  another credential/social method before changing its primary email, even while
  SSO is optional: a primary address outside the verified domain cannot use that
  organization's SSO. Check this before issuing and again when consuming email
  proofs, so removing the alternate method cannot strand an account.
- Directory provisioning initially stores pending directory records, not an
  unverified global account with credentials. First verified SSO binds or creates
  the Pertexo account; ordinary unverified existing accounts remain protected.
- Qualification includes real local HTTPS protocol/browser fixtures, ephemeral
  test certificates, forged signed claims and signatures, callback races, forced
  policy changes, invitation/session rotations and the owner recovery path. No
  new service, container download or provider account is needed.

## SAML implementation decisions (2026-10-18)

- Extend the existing provider union, management commands, readiness checks and
  organization journey. The stored provider kind already allows SAML; reuse the
  five-minute attempt and its PostgreSQL single-use consumption. Do not add a
  cache service, session authority or assertion/replay table.
- Pin `@node-saml/node-saml` 5.1.0 for Redirect requests, signed POST verification
  and SP metadata. Pin its supported security-patched DOM dependency
  `@xmldom/xmldom` 0.8.15 explicitly for strict semantic checks; use public APIs.
  Both signed response and signed assertion are mandatory. The SDK verifies
  signatures; Pertexo additionally checks exact issuer, destination, audience,
  recipient, correlation, successful status and required timestamps. Outbound
  algorithm options do not constrain incoming algorithms: reject incoming SHA-1,
  obsolete transforms, ambiguous structures/IDs, DTDs and parser recovery.
- Provider configuration holds exact IdP entity ID, HTTPS sign-in URL, up to two
  pinned RSA certificates for overlap during rotation, email/name attributes and
  JIT opt-in. Require RSA keys of at least 2,048 bits and SHA-256/SHA-512 signatures
  and digests. Certificates are public configuration; do not fetch IdP metadata or
  store assertions/tokens. Keep immutable provider identity and revision fences.
- SP entity ID is stable per identity organization and public app origin. Show it
  and the exact ACS URL before creating a provider, with a guarded metadata download
  generated by the public SDK without IdP configuration. This avoids circular IdP
  setup and keeps metadata available during certificate expiry. Providers retain
  separate pinned issuers/certificates, immutable subjects and correlated journeys. Requests are unsigned Redirect binding, responses POST binding. Document
  those requirements and persistent, immutable NameID setup at the IdP.
- Require the expected request ID in both Response and bearer confirmation. Derive
  the ID from existing browser-bound journey material; the SDK correlation seam
  exposes only that ID and the durable attempt creation time. PostgreSQL remains
  the one replay owner. Assertion freshness is five minutes with two minutes of
  skew. Require confirmation/conditions expiry; an older IdP login session may
  produce a fresh assertion (do not confuse AuthnInstant with assertion age).
- The SAML purpose cookie is HttpOnly/Secure/SameSite=None; the ordinary Better Auth
  cookie stays unchanged. SAML requires an HTTPS public app origin. Bound the
  exact callback form body to 512 KiB and decoded XML to 256 KiB (8,192 nodes, 2,048 elements,
  32 levels and 64 attributes per element), with strict
  UTF-8/base64 and one SAMLResponse/RelayState. No general cross-origin exception.
- A readiness callback does not rely on a Lax owner cookie on cross-site POST.
  The initiating owner/session, browser proof and provider revision are stored;
  final consumption checks that session and current ownership transactionally.
  Tests work while a provider is off. They create no identity, grant or replacement
  session. Sign-out/revocation,
  lost ownership or a changed provider invalidates it.
- Safe settings and metadata reads use the existing owner/admin `member:read`
  audience; mutation routes retain owner-only `workspace:manage` plus the database
  owner fence. The initial OIDC route/page incorrectly used the mutation guard for
  reads too; qualify admin reads and refused writes through the real API.
- Ownership: contracts federation settings own the discriminated provider inputs;
  database identity/federation owns settings and durable attempts; API federation/
  protocol owns SDK verification plus focused XML semantics, and journeys owns
  the callback transport. Existing feature-local SSO forms/queries own the UI.
  Keep protocol helpers in a saml sub-area; moves stay separate from logic.
- Qualification: actual SDK with owned signed fixtures, forged/wrapped/unsigned/
  SHA-1/wrong-claim/expired/replayed responses, two-instance consumption, unchanged
  OIDC/social sessions, and HTTPS desktop/phone browser journeys from a different
  IdP site. Prove the purpose cookie crosses sites, the ordinary cookie stays Lax,
  revoked owner tests fail and no response material enters proxy logs. Reuse
  existing CI jobs and owned containers; no provider account or image download.

Sources: [Node-SAML](https://github.com/node-saml/node-saml),
[xmldom security policy](https://github.com/xmldom/xmldom/security/policy),
[xmldom 0.8.15 security patch](https://github.com/xmldom/xmldom/releases/tag/0.8.15).

## SAML qualification evidence (2026-10-18)

- The real SDK passes 39 signed SAML cases alongside all 16 OIDC gateway cases:
  altered/unsigned proofs, SHA-1, wrong issuer/destination/audience/recipient,
  correlation, time bounds, duplicate IDs, XML budgets and certificate overlap.
  An exact 262,144-byte signed XML response verified in 29 ms on the local Node 24
  fixture and returned only subject, email and display name. This is a local
  measurement, not a production latency promise.
- Real PostgreSQL/API cases cover two-instance single consumption, revoked owner
  tests, changed provider revisions, JIT, required-SSO/password recovery, owner/admin
  read permissions, refused admin writes and bounded callback bodies. Unavailable
  HTTPS/secure-cookie configuration returns a clear 400 for setup and metadata.
- The real HTTPS browser configures the IdP from downloaded metadata before adding
  its provider, tests sign-in and creates a JIT member at 1,280 and 375 pixels.
  All four cross-site POSTs carry the purpose cookie and neither ordinary session
  nor CSRF cookie. Readiness creates no account; exactly two sign-in accounts
  remain. Public settings/account screenshots were inspected with reduced motion.
- Cached Caddy/nginx probes preserve exact SAML POST bytes and cookie forwarding,
  including replacement session cookies. Successful callbacks and API-down errors
  disclose no proof, binding, state or authentication path to nginx logs. The
  existing CSV, webhook and one-click checks remain green. Purge tests cover both
  provider kinds in bounded pages while retaining ordinary credentials and other
  workspaces. No Docker image download or additional CI job is needed.

## Qualification and rollout

- All slices: formatting/build/lint/types/unit/contracts/schema/boundaries; normal
  pre-push hook; exact-head required CI and CodeQL before rebase merge.
- Real PostgreSQL: domain claim races, fresh owner fences, immutable identities,
  exact retries, same-transaction rollback, role loss/removal, two API instances,
  single-use callbacks, retention and workspace/organization purge.
- Real local OIDC/SAML fixtures: success, forged/unverified/mismatched identity,
  state/browser/PKCE/nonce/issuer/audience failures, expired/replayed callbacks,
  provider changes during login, enforcement of old sessions and recovery login.
  No external IdP account or container download is needed for qualification.
- SCIM: Entra/Okta-shaped requests, filters and PATCHes; stable IDs; atomic group
  changes, conflicting roles, owner protection, token revocation, immediate access
  removal, no JIT resurrection and maximum-size projection measurements.
- Real browser at phone/desktop widths: disabled/available social buttons, domain
  proof/configuration, SSO login, enforcement/recovery, directory tokens/mappings.
  Keep forms plain and the Weft language; React Doctor after changes.
- Off by default. Operators configure their own provider accounts/credentials.
  Disable enforcement before removing the last usable provider. Recovery owner
  remains usable during an IdP outage. Guides state supported protocol/setup bounds.

## Later

Private-network OIDC endpoint access, IdP-initiated SAML, SAML logout/encrypted assertions/signed SP
requests, nested directory groups, arbitrary custom claims/roles, acting as an IdP,
and account-wide administration. No paid identity service is required.

## Tracker

- [x] Current code, scope and recommended decisions reconciled.
- [x] ADR 086 records identity/session/organization/provisioning boundaries.
- [x] Social verified linking and install setup qualified and merged: [#344](https://github.com/vigani1/pertexo/pull/344).
- [x] Organization OIDC, DNS, enforcement and recovery qualified and merged: [#345](https://github.com/vigani1/pertexo/pull/345).
- [x] SAML gateway and settings qualified; merge requires green CI.
- [ ] SCIM users/groups, mappings and removal qualified and merged.
- [ ] Guides, maximum-size evidence and natural postmerge checks complete.

## Social slice evidence (2026-10-18)

The slice adds migration 0032 and the five-minute browser-bound social proof
journey. Fifteen real PostgreSQL/API cases cover verified linking, changed provider
emails, suspension/deletion, hostile return paths, browser binding, expiry/replay,
races across API instances, concurrent first sign-in through different providers,
transaction rollback and a blocked provider call with a one-connection auth pool.
The nineteen existing account-security PostgreSQL cases also pass. Five populated
upgrade/retention suites pass (fifteen cases), including expired journey cleanup.

Nine provider-unit cases use signed RSA tokens and the pinned SDK verifier to
check signature, nonce, issuer, audience and expiry, plus actual authorization URL
state/PKCE/nonce/callback fields. Apple form landing tests verify bounded encoding,
ambiguous-proof refusal, exact cross-origin callback exceptions and unchanged
identity until GET verifies the browser binding. Oversized forms use the existing
400 invalid-proof contract; provider form POSTs consume the callback rate limit.
Native auth declares the existing start/callback policy classes in Fastify route
configuration and the dispatcher consumes that same configuration through the
shared Redis limiter. Denial and backend outages prevent provider dispatch; there
is no optional-limiter path. This also lets CodeQL recognize the guarded route.
The OpenAPI validator reports expected redirect-only callback advisories (302/303),
without validation errors.

Six real-browser journeys cover verified Google linking, new GitHub accounts and
Apple cross-site form POSTs with the ordinary Lax browser cookie
at 1280 and 375 pixels. The fixture replaces only the external provider; ordinary
registration, email verification, sessions, account pages and PostgreSQL persist
normally. Final database assertions prove six consumed journeys, six provider
identities and no persisted provider access/refresh/ID tokens. All 214 mocked
browser journeys pass; changed frontend React Doctor score is 100/100.

Cached-image deployment qualification confirms direct API auth routing, signed
cookies, API-down behavior and no callback proofs in edge/nginx logs. Five Compose
checks confirm provider credentials reach only the API. Full local checks and
exact-head CI remain the merge gate; organization modes are not enabled by this
social slice.

## Organization OIDC evidence (2026-10-18)

Migration 0033 adds the global organization/domain/provider catalog, five-minute
single-use journeys and session authentication proof. The dedicated provider key
ring uses the existing envelope; nine deployment checks qualify fresh secrets
and keep federation keys out of worker/web/migration/code-runner environments.
Startup opens stored secrets in bounded pages: correct and previous keys work;
missing or wrong keys fail clearly without exposing their values.

Real PostgreSQL/API qualification covers DNS challenge replacement/expiry and
claim races, owner fences, exact retries, rollback, verified-email attachment,
JIT defaults without resurrecting removed members, stale provider proofs,
callback races across API instances and the 16-method bound. The 107-case identity
and populated-upgrade selection and 24-case organization/purge selection pass.
Maintenance purge removes provider identities and sessions in one-row pages,
retains ordinary password credentials and other workspaces, and cannot read
password hashes. Actor-discovery hygiene is checked between workspace scopes.

Nine new real-API cases qualify owner readiness tests without identity/grant
creation, required-SSO refusal, protected recovery, preserved session proof during
password rotation, enforced email-change refusal and old email-proof consumption,
CSRF, provider outages and key recovery. A disposable PostgreSQL advisory-lock
fixture pauses the native SDK session insert while enforcement changes: the
post-insert policy check refuses and removes the raced credential session.
The broader authentication API selection passes 43 cases unchanged in intent.
Optional organization-only accounts are also refused a primary-email change
until another method exists; removing it invalidates an already-issued proof.
The ordinary invitation regression also signs out after verification, signs in
again and rebinds the new session before accepting. The global organization/
workspace catalog link is explicitly covered by the schema contract as global
authentication state (ADR 086); tenant-owned tables retain forced RLS.

Sixteen gateway tests use the actual pinned OIDC SDK and RSA signatures to reject
forged signatures, wrong issuer/audience/nonce/state, expired claims, unverified
email, unsafe endpoints and oversized discovery. Two owned HTTPS browser journeys
at 1280/375 pixels cover ordinary registration, organization/DNS/provider setup,
real discovery/code exchange/PKCE/JWT verification, owner testing, enforcement,
public sign-in, JIT and named account methods. Six existing social browser journeys
still pass. The owned IdP uses ephemeral certificates and an external-transport
fixture; production TLS/address policy has no bypass. It runs as another scenario
in the existing live-3 CI job, retaining the real admission limits.

All 214 mocked browser journeys pass. Component regressions retain secret-free
query caches and exact uncertain retries, preserve stale provider edits and keep
an open SSO confirmation's reviewed action/revision stable across a refresh.
Desktop/phone screenshots are inspected for labels, clipping and dialog exit;
React Doctor reports 100/100 without suppressions. Build, lint, strict types,
unit, generated contracts, schema and boundary checks remain commit/merge gates.

## Sources checked 2026-10-18

[Better Auth account linking](https://better-auth.com/docs/concepts/users-accounts),
[pinned session-authority decision](../adr/039-better-auth-and-session-authority.md),
[OpenID code flow](https://github.com/panva/openid-client/blob/main/examples/oidc.ts),
[Node-SAML configuration](https://github.com/node-saml/node-saml),
[SCIM protocol](https://www.rfc-editor.org/info/rfc7644/), and
[SCIMMY resource boundaries](https://scimmyjs.github.io/SCIMMY.Types.Resource.html).
Library APIs must be checked against the pinned package, not assumed from main.
