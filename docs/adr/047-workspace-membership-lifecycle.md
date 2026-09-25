# ADR 047: Leaving, suspension and ownership transfer

- **Status:** accepted
- **Date:** 2026-09-25
- **Extends:** ADR 037 (member role management), ADR 042 (member removal)
  and ADR 004
- **Amends:** ADR 043's sign-in return allowlist, adding the Team page

## Context

ADR 037 and ADR 042 let owners and admins change another member's role and
remove them, and leave out three membership journeys: people cannot leave a
workspace themselves, a member cannot be paused without losing their
membership, and the single owner can never hand the workspace over. The
product owner requested all three and set the rules below.

## Decision

Add four commands owned by the identity/workspace module. Each reuses the ADR
037/042 member-command path: the workspace-first lock order, a fresh recheck
of the actor's authority under lock, a monotonic `role_revision`, an
actor/workspace/key-scoped durable receipt in its own forced-RLS table (purged
with the workspace), one safe audit fact and the in-transaction revocation of
platform sessions in both session stores, all in one commit. Exact retries
return the stored receipt without a second audit fact or revocation; a key
reused with another body is `409 request.idempotency_conflict`. Every route
uses the cookie session, double-submit CSRF, `Idempotency-Key` and the
`ordinary_mutation` rate class.

### Leave a workspace

- `POST /v1/workspaces/{workspaceId}/leave`, strict empty body, guarded by
  `workspace:read` in an active workspace. The 200 receipt is
  `{ userId, roleRevision, replayed }`.
- Any active member except the owner can leave. The owner is refused with
  `403 auth.forbidden` and must transfer ownership first; the UI says so.
- Leaving is recorded like a removal: the membership becomes `removed`, its
  revision advances, `workspace.member_left` is audited, the receipt
  completes and every session of the person ends. There is no revision
  precondition: leaving does not depend on the role the person holds, and the
  owner check runs under the lock.
- Revocation includes the browser that asked. The web app returns to the
  workspace picker, which asks for a new sign-in first. Because the session
  that sent a committed leave has ended, an exact retry over HTTP answers
  `401`; the browser treats that as having left. Persistence still replays an
  exact retry whose first attempt committed.
- Invitations the person sent stay pending, and a later invitation may bring
  them back, exactly as after a removal (ADR 042).

### Suspend and reactivate a member

- `POST /v1/workspaces/{workspaceId}/members/{userId}/suspend` and
  `…/reactivate`, strict `{ expectedRoleRevision }`, `member:manage` route
  guard. The receipt is `{ userId, roleRevision, membershipStatus, replayed }`.
- Owners suspend and reactivate any non-owner; admins only builders,
  operators and viewers (`canSuspendWorkspaceMember`, the removal policy).
  Nobody suspends themselves and the owner is never suspended.
- Suspension changes an active membership to `suspended`. Suspended
  memberships already fail workspace authorization, discovery and the RLS
  discovery policy, so access ends on the next request; the member list keeps
  showing them, marked as suspended, and ADR 042 still lets them be removed.
  An invitation never reactivates a suspended membership (ADR 038).
- Reactivation changes a suspended membership back to `active` with the same
  role. It is a privilege change, so like a promotion under ADR 037 it also
  ends the person's sessions.
- Both advance the revision and are audited as `workspace.member_suspended`
  or `workspace.member_reactivated`. A member in the wrong state for the
  command is `409 workspace.member_status_conflict`; a removed member is
  `409 workspace.member_removal_conflict`, as for removal.

### Transfer ownership

- `POST /v1/workspaces/{workspaceId}/members/{userId}/transfer-ownership`,
  strict `{ expectedRoleRevision, expectedOwnerRoleRevision }` fencing both
  memberships, `workspace:manage` route guard (owner only). The receipt is
  `{ ownerUserId, ownerRoleRevision, previousOwnerUserId,
previousOwnerRoleRevision, replayed }`.
- Only the current owner transfers, and only to another active member with an
  active user. In one transaction the owner becomes admin first and the
  target becomes owner second, so the single-owner index is never violated
  and never relaxed. Both revisions advance, both people's sessions end and
  one `workspace.ownership_transferred` fact names the new owner.
- The request needs a fresh sign-in: the session authority's sign-in
  evidence must show the session was issued at most five minutes earlier, the
  same bound ADR 043 uses for invitation acceptance and Better Auth uses for
  email changes (`SESSION_NOT_FRESH`). An older session is
  `403 auth.session_not_fresh`; the web app offers "Sign in again" and comes
  back to Team. As in ADR 043, an authority that cannot supply sign-in
  evidence (legacy opaque sessions) answers `404`.
- A suspended or otherwise inactive target is
  `409 workspace.member_status_conflict`; a stale revision of either
  membership is `409 workspace.member_role_revision_conflict`.

### Sign-in return allowlist (ADR 043 amendment)

`/w/{workspaceId}/team` joins the allowlisted `returnTo` paths so a fresh
sign-in for an ownership transfer returns to the Team page. Nothing else about
the allowlist changes.

## Consequences

All three journeys take effect on the next request and close open run-event
streams within ADR 004's five-second bound. Revocation stays global to each
affected person, and every confirmation says so. None of them cancels runs
already started or undoes external effects. Migrations `0116`–`0118` add one
receipt table per command family (`workspace_member_departure_command_receipts`,
`workspace_member_suspension_command_receipts` for suspend and reactivate,
and `workspace_ownership_transfer_command_receipts`); no new grants on
memberships are needed. Transfer to a person outside the workspace, several
owners, suspension with an end date and bulk commands stay out of scope.

## Evidence

Disposable PostgreSQL suites cover the actor/target matrix, self and owner
rejection, status conflicts, suspended access, same-revision races, exact and
concurrent retries, rollback on a late failure, the single-owner invariant
under concurrent transfers and session revocation in both stores. The Better
Auth-only real-API suite covers CSRF, strict bodies, freshness, replay and the
next-request `401` through the HTTP stack.
