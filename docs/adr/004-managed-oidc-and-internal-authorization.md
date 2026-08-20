# ADR 004: Managed OIDC identity and internal authorization ownership

- **Status:** accepted
- **Date:** 2026-08-20

## Context

The platform needs browser authentication, internal users, workspace
membership, named capabilities, and an auditable actor identity before it can
expose tenant-owned workflow data. Authentication and authorization are
related but have different authorities: an external identity provider can
verify a person or workforce identity, while the platform must decide which
internal user may act in which workspace and what that actor may do there.

The authoritative plan chooses one managed, standards-compatible OIDC provider
instead of custom password cryptography. It intentionally leaves the specific
managed OIDC vendor as a procurement choice and requires the provider SDK to
stay inside identity infrastructure. The plan also requires explicit
workspace authorization, an immutable `ActorContext`, HTTP-only secure browser
sessions, scoped and revocable API credentials when they are needed, audit
events, CSRF protection, and PostgreSQL RLS as a defense-in-depth tenant
boundary.

This decision is required before the identity/workspace vertical slice so that
provider claims, internal authorization, session handling, repository scope,
and workspace deletion have one consistent ownership model.

## Decision

### The OIDC provider verifies identity; the platform owns authorization

Use one configured managed OIDC provider through a narrow adapter in the
identity infrastructure module. The adapter owns protocol details and SDK
usage, including the provider's configured issuer and client settings and the
authorization-code flow safeguards supported by the provider. It returns a
verified external identity identified by its issuer and stable subject. The
platform does not treat email, display name, provider groups, or mutable
claims as the durable user key.

The platform maps the verified `(issuer, subject)` to an internal
authentication identity and internal `user` record. A user may have more than
one workspace membership, but the external provider never grants workspace
access by itself. Provider-specific role/group synchronization and a
multi-provider abstraction are outside this decision; adding either requires a
new or superseding ADR. The chosen vendor remains a procurement/configuration
choice, not an implementation dependency in domain modules.

OIDC state is stored as a short-lived, single-use hash and is checked against
the callback. Use nonce and PKCE protections where required or supported by
the provider. Provider access or refresh tokens, if a later integration needs
them, belong to the connections/secret-storage boundary and are never put in
workflow graphs, sessions, actor context, audit metadata, logs, or events.

### Browser sessions are platform-owned, opaque, and revocable

After successful identity verification and internal-user resolution, the
platform creates a random opaque browser session token. The `sessions` row
stores only a cryptographic token digest, internal `user_id`, expiry, and
revocation/client metadata; the raw token is returned only in the secure
cookie and is never persisted or logged. Token lookup is by digest with a
unique constraint, and the session is rejected when expired or revoked.

The browser cookie is `HttpOnly`, `Secure` in deployed environments, and
`SameSite` according to the chosen provider's callback and application
topology. Session identifiers rotate at login and privilege-changing
boundaries, and logout, identity revocation, workspace deletion, and operator
action can revoke the local session. Local revocation is authoritative for
API access; a provider logout integration may be added behind the adapter but
is not required for local authorization correctness. Session lifecycle code
must not expose raw tokens or provider tokens to controllers or domain
records.

All state-changing browser requests use same-site secure cookies plus an
explicit CSRF defense appropriate to the provider callback and application
topology. OIDC callback state/nonce/PKCE checks protect the login transaction;
they do not replace CSRF checks on ordinary authenticated browser requests.

### API credentials are a separate actor boundary and are deferred

Service accounts and API keys are not required for the initial identity/workspace
vertical slice. Implement them only when the first external API use case
needs them, as required by the plan. They remain platform-owned credentials,
separate from OIDC sessions: keys are scoped to named capabilities and a
workspace, shown only once, stored hashed with a non-secret prefix, revocable,
and never accepted in query strings.

When present, a key resolves to a service-account actor and produces the same
authorization shape as a human actor. It does not bypass membership,
workspace status, capability checks, RLS, rate limits, or audit requirements.
The key's exact issuance and rotation API is deferred until that external API
use case is selected.

### Authorization is internal, explicit, and capability-based

The workspace is the tenant and authorization boundary. Roles and membership
status are stored by the platform, and one policy module maps roles to named
capabilities such as `workflow:read`, `workflow:publish`, `run:start`,
`connection:use`, and `member:manage`. Suspended, removed, and
pending-deletion memberships cannot authorize normal workspace operations.

Every request selects a workspace explicitly from the route/use-case context.
The backend verifies that the authenticated actor has the requested
capability in that workspace before opening a tenant transaction. A mutable
"current workspace" value in a session, client body, or process-global
singleton is never proof of access. Where disclosure policy requires it, an
unauthorized workspace resource is returned as not-found.

The authentication guard creates an immutable `ActorContext` containing at
least the internal actor ID, actor kind, selected workspace, session or
service-account identity when applicable, and request ID. Controllers pass it
explicitly to application use cases. Workers carry workspace scope in job
payloads and verify the referenced run/resource before acting; they do not
inherit a user session.

### Authorization and RLS are separate checks

Authorization happens before a request opens a workspace-scoped database
transaction, and sensitive operations such as credential resolution check
authorization again at their application boundary. Tenant repositories require
an explicit `workspace_id` and use the transaction helper defined by ADR 003.
The API and worker runtime roles set transaction-local workspace context with
`SET LOCAL`; they do not use a privileged connection.

Users, external authentication identities, and sessions are platform identity
records that may exist before or across workspace memberships. Memberships
and other tenant-owned rows carry `workspace_id` and use forced RLS. RLS
prevents a missed predicate from crossing tenants, but it does not decide
whether an actor has a capability. A request with a valid session and an
arbitrary workspace ID therefore fails authorization before it can rely on
RLS.

### Security and product actions produce safe audit facts

The platform's audit module owns append-only security and product actions.
Workspace creation, membership and role changes, identity/session
revocation, workflow publication, credential access, run replay, deletion,
restore, and other destructive actions record an audit fact with actor,
workspace (when applicable), target, request/trace identifiers, and bounded
safe metadata. The `identity.revoked` event is the integration signal for
identity revocation. Raw session tokens, OIDC tokens, PKCE verifiers,
credentials, and unbounded provider claims are never audit data.

Audit writes participate in the same command transaction as the state change
when the operation is transactional. Events that cross module or process
boundaries use the platform's outbox/event contracts; audit history is not
reconstructed from provider logs.

### Workspace deletion and restore bound identity access

Requesting deletion is an authorized workspace command. The transition to
`pending_deletion` records actor, reason, request time, and `purge_after`, and
atomically revokes local sessions for affected actors and workspace API keys,
disables public triggers, and prevents new runs. Active work receives durable
cancellation under the execution rules; already-completed external effects
are not erased.

Before `purge_after`, an authorized restore changes the workspace to
`suspended`. Restore does not silently re-enable integrations, triggers, or
previous credentials; those require explicit follow-up authorization. At the
purge deadline, the workspace and its tenant-owned identity/membership and
related data follow the resumable purge policy. After the final `deleted`
tombstone, the workspace cannot be restored. Legally retained audit facts are
minimized or anonymized according to the retention decision, not used to
recreate access.

## Consequences

Positive consequences:

- A managed provider handles authentication protocol and password risk while
  the platform retains stable internal identity and authorization semantics.
- Workspace access is explicit and testable, independent of provider group
  claims or a mutable client-selected workspace.
- Opaque, hashed sessions can be revoked immediately without making API
  authorization depend on provider-session availability.
- The immutable actor context, audit facts, and RLS transaction boundary give
  API and worker code the same identity and tenant vocabulary.
- Service-account credentials can be added for a real external API use case
  without coupling them to browser login.

Costs and obligations:

- The identity adapter must be kept narrow and tested against the selected
  provider's issuer, callback, state, nonce, PKCE, rotation, and revocation
  behavior.
- The platform must operate session expiry, rotation, revocation, CSRF,
  membership policy, audit retention, and deletion recovery correctly; OIDC
  does not provide these product controls.
- Each tenant use case carries explicit actor and workspace context and must
  pass both authorization and RLS integration tests.
- Vendor selection and any provider-specific logout, claims, or enterprise
  features remain procurement/product decisions and must not leak into core
  domain packages.

## Rejected alternatives

### Custom password authentication

Rejected for V1. It would make the platform responsible for password
cryptography, account recovery, abuse controls, and credential lifecycle even
though the plan deliberately chooses managed OIDC.

### Trust provider groups or claims as workspace authorization

Rejected. Provider claims can identify an external principal but cannot
replace platform-owned memberships, workspace status, capability policy, or
RLS scope. Claim synchronization would also introduce provider-specific
authorization semantics that are not required for the first slice.

### Use OIDC tokens as the application's browser session

Rejected. Directly exposing provider token lifetime, revocation, and claims to
every product module would couple product authorization to an external token
format and make local session revocation and audit semantics unclear. The
platform uses an expiring opaque session whose digest is stored locally.

### Put authorization state in a process-global or client-selected workspace

Rejected. It is unsafe with multiple API replicas and cannot provide a
reliable tenant boundary. The request's explicit workspace is checked against
the immutable actor context, application policy, and PostgreSQL RLS.

## Implementation constraints

This ADR authorizes the Phase 1 identity/workspace vertical slice only: managed
OIDC login, internal user mapping, workspace membership, an authorized request,
and an audit event, plus workspace creation and deletion-request/restore
foundation. It does not authorize a multi-provider framework, custom
passwords, enterprise identity synchronization, invitations, or service
accounts/API keys before a concrete external API use case needs them.

The SDK and protocol adapter live only in identity infrastructure. Domain
modules depend on internal identity and authorization ports, not provider
types. Session token digests, OIDC state, and all credentials are treated as
secrets; logs, events, errors, and graph JSON contain safe references only.
The Phase 1 proof must use real runtime roles for RLS, exercise cross-workspace
authorization, verify session revocation and CSRF behavior, and record the
audit fact and deletion/restore boundary. A provider choice or a broader
authorization model requires a follow-up ADR.
