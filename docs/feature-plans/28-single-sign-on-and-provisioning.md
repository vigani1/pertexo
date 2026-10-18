# F28 — Single sign-on and provisioning

Status: implementation authorized; current-code plan reconciled. Updated: 2026-10-18.
Parent: [roadmap](../product-roadmap.md). Decision: [ADR 086](../adr/086-federated-sign-in-and-provisioning.md).

## Current code

Better Auth 1.7.7 owns every browser session. Google/GitHub credentials already
configure social sign-in per install, absent/off by default; capability discovery
and the sign-in buttons already follow that configuration. There is no instance
administrator role or global settings page. Keep instance configuration in the
existing environment settings rather than creating another administration system.

ADR 039 currently refuses implicit same-email linking. The new request changes
that rule for verified identities. Inspection of the pinned native social callback
found that existing-account attachment is not transactional with post-creation
hooks. Use the existing configured-provider proof gateway and a short Pertexo
identity transaction, as purpose-bound linking already does. Explicit linking from
account settings retains its two-sided, browser-bound proof. Native arbitrary
linking endpoints remain closed.

There is no identity organization, verified-domain registry, organization OIDC or
SAML, or SCIM. The reset removed the legacy OIDC session bridge; do not restore it.
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
  or mismatched binding fails. Local fixtures use the same-origin development path.
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

Private-network IdPs, IdP-initiated SAML, SAML logout/encrypted assertions/signed SP
requests, nested directory groups, arbitrary custom claims/roles, acting as an IdP,
and account-wide administration. No paid identity service is required.

## Tracker

- [x] Current code, scope and recommended decisions reconciled.
- [x] ADR 086 records identity/session/organization/provisioning boundaries.
- [ ] Social verified linking and install setup qualified and merged.
- [ ] Organization OIDC, DNS, enforcement and recovery qualified and merged.
- [ ] SAML gateway and settings qualified and merged.
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

## Sources checked 2026-10-18

[Better Auth account linking](https://better-auth.com/docs/concepts/users-accounts),
[pinned session-authority decision](../adr/039-better-auth-and-session-authority.md),
[OpenID code flow](https://github.com/panva/openid-client/blob/main/examples/oidc.ts),
[Node-SAML configuration](https://github.com/node-saml/node-saml),
[SCIM protocol](https://www.rfc-editor.org/info/rfc7644/), and
[SCIMMY resource boundaries](https://scimmyjs.github.io/SCIMMY.Types.Resource.html).
Library APIs must be checked against the pinned package, not assumed from main.
