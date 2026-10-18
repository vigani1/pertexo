# ADR 086: Federated sign-in and directory-managed access

- **Status:** accepted under the owner's authorization to choose recommended F28 decisions
- **Date:** 2026-10-18
- **Extends:** ADR 039 (one session authority), ADR 047 (membership lifecycle)
- **Amends:** ADR 039's blanket refusal of implicit verified-email linking and its social-proof handoff constraint
- **Plan:** [F28](../feature-plans/28-single-sign-on-and-provisioning.md)

## Context

The install already supports configured social providers through Better Auth.
Organization OIDC/SAML and directory provisioning need a durable authentication
boundary without replacing Pertexo roles, workspace isolation or immediate access
removal. A directory is not evidence that its submitted email owns an existing
Pertexo account. Builder and operator capabilities are not hierarchical.

## Decision

Keep Better Auth as the only browser-session authority. Federation is a provider
proof followed by the existing transactional account/session row and cookie
handoff; it does not introduce a broker session or revive the reset's legacy OIDC
bridge. Session eligibility checks active identity, domain enforcement and the
session's proven provider at issuance and lookup. Policy changes revoke affected
sessions. Authorization continues to use current Pertexo memberships.

Social linking requires equal, verified provider and local emails. No forced
trusted-provider override, local email reassignment or automatic link to an
unverified local account. Existing explicit linking retains two-sided proof and
its browser/session binding. Provider attachment revokes previous sessions and
records the existing identity security event. The pinned native social callback
attaches existing accounts before post-creation hooks; it cannot make that
attachment, audit and revocation atomic. Reuse configured Better Auth provider
verification behind the existing browser-bound proof pattern, then finalize all
identity changes in one short PostgreSQL transaction. Native implicit linking and
callbacks remain closed. This is not a copied credential/OAuth verifier or an
independent session lifecycle: Better Auth providers verify the proof and Better
Auth delivers its existing session cookie. Network calls finish before checkout.
Apple form POSTs use a bounded transport-only 303 landing onto the same GET
callback. Front-channel tokens and profiles are ignored; the ordinary Lax browser
binding and session cookies authorize the subsequent verified callback. Only the
two exact Apple callback paths bypass the same-origin POST fence.

Organization OIDC treats a signed configured issuer as authoritative only within
its exact DNS-verified domains. A missing `email_verified` claim is allowed there
for providers such as Entra; explicit false is refused. Social verification stays
strict. The generic OIDC gateway explicitly enables the library’s JWS signature
checks in addition to TLS, issuer/audience, state/nonce and PKCE.

An identity organization is controlled by one existing workspace and may link up
to ten workspaces with explicit ownership consent. Its current control-workspace
owner administers authentication and provisioning using `workspace:manage`; this
creates no organization role system. Each workspace has at most one identity
organization. Its data remains workspace-scoped. The global authentication catalog
is deliberately limited to domain/provider/directory identity and proof state;
management rechecks the control-workspace owner under lock.

Domain ownership requires single-use DNS TXT proof for the exact normalized domain.
Only verified claims are globally exclusive. Enforced domains govern account
sign-in across this install; linked workspaces determine JIT membership grants.
Domain enforcement is optional and
requires a tested provider and a working recovery owner password. The existing
control-workspace owner is the break-glass account, protected from provisioning
and loss of its last password while enforcement is enabled. Ownership transfer
must preserve that recovery path. Recovery uses existing rate-limited password and
session security and is audited; its exception cannot bypass another organization’s
domain policy. Session replacement preserves the source authentication proof, and
ordinary email changes cannot escape active enforcement. There is no shared emergency credential.

Organization client secrets reuse the existing application-secret envelope with a
dedicated private API key ring. Stored secrets must open at startup; retained
previous keys support rotation and restored databases need their keys supplied
separately. Account attachments share the existing 16-method response bound.

OIDC uses code/PKCE/state/nonce and immutable issuer/subject identity. SAML uses
SP-initiated, correlated, browser-bound, signed responses/assertions and immutable
IdP entity/NameID identity. Journeys bind one provider revision, expire in five
minutes and are consumed once across API instances. SAML's cross-site POST gets a
purpose-bound Secure SameSite=None cookie; ordinary session cookies are unchanged.
Protocol libraries verify signatures and assertions. OIDC server requests reuse
the existing secure HTTP transport. Provider credentials reuse the versioned
application-secret envelope with purpose/provider associated data.

SCIM's protocol parser and persistence remain separate. A provisioning bearer
credential authorizes only its organization. Directory IDs are stable. Pending directory records create no unverified global
account; first verified SSO binds or creates it. Unverified email alone cannot bind
an existing account. Verified SSO proof binds that identity
before directory-managed grants apply. JIT cannot recreate access from an inactive
directory record. Groups map to one existing workspace role by explicit priority,
with a default role when none matches; there is no capability union or automatic
owner. Ordinary role edits direct managed members back to their directory policy.

Every provisioning mutation, effective membership update, removed-member cleanup,
role revision, session revocation and audit fact commits together in the existing
PostgreSQL transaction model. Other organizations/manual memberships remain
independent; deprovisioning one organization does not suspend the whole account.
Use the existing membership storage/removal owners rather than a second access
projection implemented by an authentication plugin. No new service, queue, role
or CI job is required.

## Consequences

Organization ownership is a deliberate delegation of authentication and directory
management. Configuration, JIT and provisioning share existing membership and
session policy. Domain enforcement cannot be bypassed by ordinary password/social
sessions, password reset or callbacks started before a provider change.

The owner remains a recovery authority even during an IdP outage. Provider
configuration is owner-only because changing who proves an identity can otherwise
escalate an admin to another person's privileges. This is stricter than reading
safe configuration or the audit log.

Application changes append bounded metadata audit facts; tokens, credentials,
claims/assertions and arbitrary provider text are excluded. Workspace/organization
purge and short-lived proof cleanup are part of rollout. Detailed protocol bounds,
resource limits and acceptance cases live in the short feature plan.

Private-network IdPs and additional SAML modes remain explicit later work; they
must not weaken the initial public-HTTPS, correlated proof boundary. Actual
provider account registration is operator setup, not a hosted service dependency.
