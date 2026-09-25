# ADR 038: Recipient-bound workspace invitations

- **Status:** accepted
- **Date:** 2026-09-19
- **Amended:** 2026-09-25 by ADR 042 and ADR 043

> **Amendment note (2026-09-25).** [ADR 043](043-self-service-profile-and-session-authority-journeys.md)
> registers acceptance under the active session authority: besides the fresh
> OIDC result below, a session authority that verifies email (Better Auth) may
> prove the recipient with a sign-in issued at most five minutes earlier, and
> the acceptance routes no longer depend on legacy OIDC being configured.
> [ADR 042](042-workspace-member-removal.md) lets a later invitation make a
> _removed_ membership active again at the invited role; a suspended
> membership remains a conflict. The rest of this record is unchanged.

## Decision

Extend ADR 004 and ADR 037 with one bounded email-address workspace-invitation
flow. Owners may invite `admin`, `builder`, `operator` or `viewer`; admins may
invite only `builder`, `operator` or `viewer`. Invitations never grant `owner`,
change an existing member's role, reactivate an inactive membership, or perform
ownership transfer. Authorization is evaluated from current locked database
state and an active workspace, not cached UI roles.

An invitation identifies a recipient address but email is not a durable user
identity. Acceptance requires a fresh OIDC result for the bound journey, the
stable `(issuer, subject)` identity, `email_verified: true`, and an exact match
between the provider-verified address and the normalized invited address. A
provider that omits verification is not eligible without a later trusted-issuer
decision. Wrong-account attempts do not consume the invitation. A matching
active existing member completes it as an audited no-op and keeps the current
role; suspended or removed membership is a conflict. Email never links two
authentication identities.

Invitations expire after seven days. A workspace may have one pending
invitation for a normalized address. Recipient and role are immutable. Resend
rotates the high-entropy token, advances the invitation revision, restarts the
seven-day lifetime and invalidates both older links and already-resolved
acceptance intents. Revocation, expiry and workspace deletion also invalidate
completion. Terminal invitation recipient data is minimized after 90 days,
subject to the platform retention policy; audit facts retain identifiers and
bounded safe metadata, never addresses or secrets.

Raw invitation tokens appear only in the fragment of the delivered browser URL
and the resolver request body. Persistence stores a digest; delivery retains a
sealed copy only for the bounded provider attempt. Resolution creates a
single-use acceptance intent with an independent HttpOnly browser binding. The
intent lasts at most 15 minutes and never beyond invitation expiry. Fresh
verified-email evidence lasts five minutes and cannot extend the intent.
OIDC state carries only the server-owned intent continuation and returns to the
fixed `/invitations/accept` route. Explicit wrong-account recovery uses the
standard `prompt=select_account` request hint; ordinary acceptance does not
claim the provider forced credential re-entry.

The identity/workspace module owns completion as one command. It rechecks the
workspace, generation, invitation state, recipient proof and membership under
locks. A new membership, invitation consumption, audit receipt, revocation of
the accepting user's older sessions and issuance of the completing browser's
replacement session commit together. An already-member no-op does not revoke
sessions. Lost responses recover through the bound receipt or ordinary OIDC
sign-in and workspace discovery; raw replacement session tokens are never
persisted for recovery, and reconciliation never repeats the grant or session
rotation.

Invitation email is an application-owned identity message. It uses a dedicated
system Resend credential and verified sender through an identity-invitation
adapter and the durable PostgreSQL outbox. It does not use workflow nodes,
notification destinations, or customer/workspace connections. Provider
idempotency is retained for the same delivery attempt. Definite or uncertain
delivery failure does not mint a new invitation generation; explicit resend is
a new manager command after reconciliation.

## Consequences

The stable OIDC subject remains identity authority while invitations can reach
new and existing users. Single-use tokens, browser binding, generation fencing,
database authorization and exact command receipts keep possession of an email
string or stale link from becoming membership authority. The flow adds
short-lived platform acceptance records, tenant invitation/delivery records, a
dedicated system-mail configuration, and controlled-provider operational work.
Acceptance is intentionally unavailable when the provider cannot assert a
verified email.

Role-management semantics remain unchanged. An invitation to an existing active
member cannot bypass ADR 037's revision, authorization or session rules.
Workspace deletion serializes with invitations and does not reactivate them on
restore. Existing sessions and long-lived SSE connections continue to follow
ADR 004 after privilege-changing acceptance.

## Rejected alternatives

- Treating email or link possession alone as membership authority.
- Trusting an old browser session or an unverified/missing email claim.
- Updating an existing member to the invited role.
- Mutable pending invitations or resending an old generation.
- Persisting raw invitation or replacement-session tokens for recovery.
- Customer Resend connections, workflow actions, copy-link-only delivery, or a
  speculative multi-provider mail framework.

## Implementation constraints

The detailed contracts, lifetimes, lock order, recovery rules and acceptance
gates are in the frontend architecture plan's workspace-invitations section.
Use forward-only migrations, forced RLS and established runtime roles. The
controlled full-stack gate may use local OIDC and Resend-compatible servers;
production managed-provider, sender-domain and cross-browser evidence must be
reported separately until available.
