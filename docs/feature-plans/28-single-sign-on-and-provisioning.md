# F28 — Single sign-on and user provisioning

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-29. Parent: [product roadmap](../product-roadmap.md).
Scope: Extends the existing session authority for organizations. Relative size: **L–XL**, not a calendar estimate.

## Outcome

An organization signs its people in through its own identity provider and
adds, suspends and removes them from Pertexo automatically, so access follows
the company directory instead of manual invitations.

## Current implementation and evidence

People sign in with email and password or configured social providers through
Better Auth, with a legacy OIDC path
([ADR 039](../adr/039-better-auth-and-session-authority.md),
[ADR 004](../adr/004-managed-oidc-and-internal-authorization.md)). Workspace
roles, invitations, suspension and removal exist. There is no per-organization
SAML or OIDC connection and no SCIM provisioning.

Inspected anchors (paths may move):

- [docs/adr/039-better-auth-and-session-authority.md](../adr/039-better-auth-and-session-authority.md)
- [docs/adr/047-workspace-membership-lifecycle.md](../adr/047-workspace-membership-lifecycle.md)

## Dependencies and planning gate

F18 decides who administers organization-wide settings. Independent of the
workflow product otherwise.

Resolve in an ADR before code:

- **Organization boundary**: SSO belongs to an organization that owns one or
  more workspaces, not to a single workspace; verified domain ownership before
  enforcing SSO for an email domain.
- **Protocols**: SAML 2.0 and OIDC through the existing session authority;
  just-in-time accounts; whether password sign-in is disabled for SSO users.
- **Role mapping**: which directory groups map to which workspace roles, and
  whether manual role changes are overwritten.
- **SCIM**: create, update, suspend and delete people through a scoped
  provisioning token; deprovisioning ends sessions like ADR 047's lifecycle.
- **Recovery**: an owner break-glass path when the identity provider fails.

## Ownership and structure

Identity infrastructure and session authority; organization and domain
persistence; SCIM API; web organization settings.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).

## Frontend work

Organization settings for domains, SSO connection and enforcement, role
mapping and SCIM token management; SSO entry on the sign-in page.

## Backend work

SAML/OIDC connection storage and verification, domain verification, SSO
enforcement, SCIM 2.0 users and groups endpoints, audited deprovisioning that
revokes sessions and memberships.

## Delivery slices

1. ADR for organization boundary, domains, protocols and recovery.
2. SAML/OIDC sign-in with just-in-time accounts and domain enforcement.
3. SCIM provisioning and group-to-role mapping.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Sign-in through a test identity provider; enforcement blocks password sign-in
for the domain; deprovisioning ends sessions within the stated bound; group
changes update roles; break-glass works; tokens are scoped and revocable.

## Non-goals

Acting as an identity provider for other products, cross-organization guest
federation.

## Rollout and rollback

Per organization and off by default; disabling enforcement restores other
sign-in methods without losing accounts.

No production rollout, paid provisioning or real external calls are authorized
by this plan.

## Competitor context

Zapier offers SAML single sign-on and SCIM provisioning
([SAML](https://help.zapier.com/hc/en-us/articles/8496279747085-Set-up-single-sign-on-with-SAML),
[SCIM](https://help.zapier.com/hc/en-us/articles/8496291497741-Provision-user-accounts-with-SCIM)).
n8n supports SAML and OIDC single sign-on with role provisioning
([set up SSO](https://docs.n8n.io/hosting/securing/set-up-sso/)).

Research checked 2026-09-29; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation.

## Delivery tracker

- [ ] Baseline reconciled against current code and accepted decisions.
- [ ] Product choices resolved; necessary ADR accepted.
- [ ] Contracts and security model reviewed.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: none for this new plan.
