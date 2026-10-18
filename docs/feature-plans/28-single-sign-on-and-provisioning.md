# F28 — Single sign-on and provisioning

Status: complete; social, organization OIDC, SAML and SCIM merged (#344–#347). Updated: 2026-10-18.
Parent: [roadmap](../product-roadmap.md). Decision: [ADR 086](../adr/086-federated-sign-in-and-provisioning.md).

## Current code and ownership

Better Auth 1.7.7 remains the only browser-session authority. Social sign-in is
merged in [#344](https://github.com/vigani1/pertexo/pull/344), organization OIDC in
[#345](https://github.com/vigani1/pertexo/pull/345), and SAML in
[#346](https://github.com/vigani1/pertexo/pull/346). Migration 0032 owns social
journeys, 0033 organization identity, and 0034 directory provisioning.

API `authentication/federation` owns proof/protocol orchestration; database
`identity/federation` owns identity commands and transactions. Existing membership,
session, audit, removal and retention owners remain authoritative. Contracts own
management boundaries; SCIM's protocol adapter owns its input boundary. Web
`features/federation` owns settings and sign-in UI. No new service, database role,
queue, CI job or global instance-administration application.

## Authority and configuration

- An identity organization links at most ten workspaces under a control workspace.
  Its current owner manages authentication/provisioning using `workspace:manage`;
  owners/admins can read safe configuration and audit. Changing who proves an
  identity is owner-only. No additional organization role.
- Linking requires ownership of both workspaces, shows the delegation explicitly,
  and permits one organization per workspace. Either owner can unlink a non-control
  workspace; the control workspace cannot unlink itself.
- Organization bounds: twenty domains, ten providers. Google/GitHub application
  credentials remain existing operator environment configuration, absent/off by
  default. Existing Microsoft/Apple configuration continues through the same proof
  gateway. Application settings changes are audited.
- Small global identity catalogs are the existing authentication exception to
  workspace RLS. Directory membership provenance is a workspace-fenced source
  association; it is not another role/status store. Ordinary clients receive no
  cross-workspace database role.

## Sign-in, domain verification and recovery

- Social linking requires equal normalized, verified provider and local emails.
  Never change local email during linking. Explicit account linking keeps both
  browser-bound proofs. Native implicit linking/callback endpoints remain closed.
  Provider verification occurs before checkout; attachment, audit, prior-session
  revocation, new Better Auth session and journey consumption commit together.
- Apple form POST callbacks use a bounded 32 KiB URL-encoded transport and
  same-origin 303 GET before cookie-bound verification. Ignore front-channel
  tokens/profile data; ordinary session cookies remain Lax.
- A random DNS TXT challenge proves each exact ASCII/lowercase domain. No inherited
  subdomain claims; one verified organization per domain/install. Challenges expire
  in seven days and replacement invalidates the old one. DNS I/O happens outside
  transactions; consumption rechecks challenge/revision/expiry. No periodic DNS job.
- OIDC uses authorization code, S256 PKCE, state/nonce and issuer/audience/signature/
  expiry/subject validation. Identity is issuer + subject. Google Workspace, Entra,
  Okta and generic public-HTTPS issuers share one implementation. Existing secure
  HTTP transport bounds discovery/token/key fetches, checks addresses and refuses
  redirects. Signed verified-domain claims are authoritative; explicitly unverified
  email is refused. Social verification remains stricter.
- SAML is SP-initiated Redirect/POST, with both response and assertion signed by a
  pinned RSA certificate, correlation, issuer/audience/recipient/destination and
  bounded timestamps. Maximum assertion age five minutes, two-minute clock skew.
  Persistent immutable NameID owns identity. At most two current certificates
  support rotation. Unsupported SAML options remain explicit below.
- Use pinned `openid-client` and `@node-saml/node-saml`, never handwritten JWT/XML
  signature validation. Provider secrets use the existing versioned application
  envelope with provider/purpose associated data. Restores supply keys separately.
- Journeys bind the browser and exact provider revision, expire in five minutes,
  and succeed once across API instances. Existing retention removes expired proofs
  after a day. SAML alone uses a Secure, HttpOnly, SameSite=None purpose cookie on
  HTTPS; a missing binding fails safely. Ordinary session cookies are unchanged.
- Caddy routes `/v1/auth/*` straight to the API with existing URI/header redaction;
  nginx never receives codes, state, proof tokens or SCIM credentials. Reuse the
  cached-image proxy qualification, including API-down privacy and cookie forwarding.
- Required SSO is off by default. Enabling needs DNS proof, an enabled current
  provider tested on that domain, and a working verified-password control owner.
  Check policy on issuance and every session read. Passwords, social sign-in,
  password reset, email changes and old linking journeys cannot bypass it.
  Provider/enforcement changes revoke affected sessions and invalidate readiness.
- The current control owner retains protected, audited password recovery. Refuse
  removing that password or transferring ownership to someone without one while
  enforcement applies. Ownership elsewhere grants no exception. Provisioning never
  controls or removes this owner. No shared recovery password/new recovery service.

## Membership and directory decisions

- Unprovisioned JIT is opt-in per provider. Linked workspaces choose an existing
  default role, viewer initially. Never assign owner automatically. Existing manual
  roles, suspended memberships and removals remain independent.
- Pending SCIM records create no global account. First verified organization SSO
  binds/creates an active provisioned identity even with unprovisioned JIT off.
  SCIM email alone cannot claim an account. Conflicts fail visibly. Directory
  profiles do not silently rename accounts or change passwords.
- Inactive/deleted records fence JIT, session issuance and organization-session
  reads. User deletion retains a tombstone, returns 404 and removes it from lists.
  A deliberately provisioned active replacement requires verified SSO again before
  previously managed access can return. The retained-user quota includes tombstones.
- Stable group IDs map to one workspace role by priority: first matching group
  wins, otherwise its default role. Builder/operator are incomparable; no role union.
  Routine provisioning advances resource ETags, not organization configuration.
  Deleting a mapped group advances organization revision because policy changed.
- Managed role/status remains in existing workspace memberships. Ordinary role,
  suspension, removal, ownership-transfer and leave commands refuse directory-owned
  grants with HTTP 409 `workspace.member_directory_managed`, not an actor-permission
  403. Team rows explain the source and where to change access.
- An owner can explicitly adopt an active manual membership after verified SSO has
  bound the directory person. Review the resulting role and atomically recheck
  organization, directory and membership revisions. Never silently adopt, reactivate
  a manual removal/suspension or manage the recovery owner.
- Resource/mapping/default-role changes project bound managed grants in the same
  transaction as credential authorization, cleanup, session revocation and audits.
  Batch through existing membership storage; no per-person round trips. Only changed
  roles/status advance membership revisions/revoke sessions. Ordinary group changes
  project the symmetric difference; policy changes may project all bound people.
- Lock sorted workspaces, then organization, then sorted affected global users
  before proving the owner. Recheck changed linked sets. Purge uses the same sorted
  workspace plan with bounded SKIP LOCKED claims. Unlink/control-organization purge
  removes grants in linked workspaces before removing provenance; never convert
  managed access into manual access. Preserve unrelated memberships/accounts.
  Maintenance gets only required metadata/cleanup permissions, never passwords.

## SCIM boundary and bounds

- Native API endpoints: `/v1/auth/federation/scim/:organizationId/v2`. Support core
  Users/Groups discovery, lists, reads, POST/PUT/PATCH/DELETE, active=false and group
  membership. No new router framework or Better Auth plugin membership authority.
- Bearers are random 256-bit, organization-scoped, digest-only and shown once.
  Creation receipts/retries contain metadata only. Rotation creates a replacement
  before revoking the old credential; current owner revocation is immediate across
  instances. Creator role changes do not change an organization's credential.
  Lost creation responses direct owners to inspect/revoke, not recover plaintext.
  At most five active credentials; retain revoked metadata thirty days.
- Authenticate and rate-limit all endpoints, including discovery, using existing
  fail-closed distributed limits: pre-auth IP 600/minute and organization 300/minute.
  Use bounded JSON/SCIM+JSON with safe SCIM errors even before controller dispatch.
  Empty DELETE is valid. Never use browser cookies as provisioning credentials.
- Public `scimmy` 1.3.5 supplies schema coercion/metadata only. Its matching ignores
  caseExact and its AST loses negated value semantics; use `scim2-parse-filter`
  0.3.0's preserved AST and `scim-patch` 0.9.3 on a detached canonical copy.
  Compile fixed supported descriptors to parameterized SQL; no caller identifiers,
  exponential DNF, global SDK resource registry or custom signature machinery.
- Canonicalize case-insensitive attribute/operation names, preserve quoted values,
  reject ambiguous duplicates/unsupported fields/passwords. Check read-only
  id/meta/schemas/User.groups before coercion after each PATCH operation. Selecting
  a primary email clears earlier primary flags before the next operation. Groups
  reference Users only; discovery must not advertise nested groups.
- Lists support one-based pagination, count=0, modeled sorting and attributes/
  excludedAttributes. Optional weak opaque resource If-Match checks fail with 412
  atomically. Unknown filters/paths fail clearly rather than silently guessing.
- Bounds: 5,000 retained users, 200 groups, 500 members/group, 200 mappings/workspace,
  ten linked workspaces, 100 operations/PATCH, 1 MiB request, 4 MiB response,
  16 KiB profile, five emails/person, page size 100. Pre-SDK JSON depth/member bounds
  are 16/4,096. Filters: 1,024 characters, nesting sixteen, 256 AST nodes, budgeted
  before recursive work. Reject oversized changes atomically.
- Audits contain metadata only for configuration, DNS/enforcement, sign-in/linking,
  JIT, credentials, resources, mappings, adoption, unlink and deprovisioning. System
  provisioning facts name the credential ID, not its creator as an impersonated actor.
  Never audit secrets, claims, assertions, passwords, raw profiles or provider errors.

## Delivery and evidence

1. Social proof/linking: merged #344. Real provider-gateway identity/link/session
   cases, retention/migration tests and desktop/phone browser setup passed.
2. Organization OIDC/DNS/JIT/enforcement/recovery: merged #345. Owned HTTPS IdP,
   PostgreSQL and real-browser setup/sign-in/recovery qualified; proxy privacy passed.
3. SAML: merged #346. Real cross-site signed assertions and desktop/phone settings,
   metadata, test-sign-in, enforcement and account-method browser journeys passed.
4. SCIM: merged in [#347](https://github.com/vigani1/pertexo/pull/347). Move-only membership extraction
   precedes batch-storage and protocol logic commits. Owners manage credentials,
   people, ordered mappings, explicit adoption and unlink in existing Weft settings.
   Secrets stay out of Query caches; edited mappings/reviews survive refreshes and
   use exact revisions. Untouched mappings follow refreshed server snapshots.

Local Node 24/PostgreSQL 18 evidence, 2026-10-18 (measurements, not deployment SLAs):

- Full fan-out: 5,000 bound people × ten workspaces, 200 groups, 100,000 member
  references and 2,000 mappings. One command changed 50,000 grants/audits and revoked
  5,000 sessions in 2.1–2.3 seconds, about 77 MB WAL and 31–44 MB process RSS growth.
  Reapplying identical roles preserves revisions/sessions. Keep these bounds.
- A maximum 100-group page with 500 members each and maximum profile labels encoded
  to 2,573,733 bytes in about 12 ms, below 4 MiB. Maximum-length/depth filter parsing
  averaged 1.24 ms across 100 iterations. Bounded codec/parser behavior is tested.
- Real API federation/member lifecycle suite: 56 passing cases, including SCIM
  authentication/media/filters/PATCH/ETags, revocation and current membership policy.
  Real database tests cover projection, filters, ownership, adoption, tombstones,
  cross-organization isolation, unlink, maintenance purge and full fan-out.
- Owned real HTTPS SAML + SCIM browser journeys pass at 1280px and 375px: credential
  creation, pending person/group, builder mapping, verified SSO with JIT disabled,
  managed team membership, inactive person and credential revocation. Screenshots
  inspected at both widths. No external provider account or image download.
- Native SCIM registration uses the same per-method Fastify shorthand as the
  existing authentication boundary. Runtime IP/organization admission still runs
  before parsing/authentication/dispatch; real API tests exercise refusal and
  backend-unavailable responses on every supported method. CodeQL's per-route
  limiter model excludes the alternative `route({...})` registration form.
- Web unit suite: 1,284 cases passing. React Doctor changed scope: 100/100, no
  suppressions. Final lint/types/build, contracts/schema/boundaries, mocked browser
  suite and normal hooks/required CI remain merge gates.

## Later

Private-network OIDC, IdP-initiated SAML, encrypted assertions, signed SP requests,
SAML logout, nested groups, arbitrary schema/role/claim extensions, SCIM bulk,
acting as an IdP and account-wide administration. Use compatible OIDC when an IdP
requires unsupported SAML options. No paid identity service is required.

## Tracker

- [x] Reconcile current code and accepted ADR 086 decisions before each slice.
- [x] Social, organization OIDC and SAML qualified and merged (#344–#346).
- [x] SCIM backend/UI, immediate removal, purge, bounds and real browser qualification.
- [x] Update [sign-in/provisioning guide](../guides/single-sign-on.md).
- [x] Final SCIM PR checks and rebase merge (#347), main `cffe07669`.
- [x] Natural-main CI 39107159734 and CodeQL 39107159751 pass on `cffe07669`.

Protocol references: [SCIM protocol](https://www.rfc-editor.org/info/rfc7644/),
[SCIMMY schemas](https://scimmyjs.github.io/SCIMMY.Types.SchemaDefinition.html),
[filter parser](https://github.com/15five/scim2-parse-filter),
[PATCH library](https://github.com/thomaspoignant/scim-patch),
[OIDC client](https://github.com/panva/openid-client),
[Node-SAML](https://github.com/node-saml/node-saml).
