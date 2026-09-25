# ADR 042: Bounded workspace member removal

- **Status:** accepted
- **Date:** 2026-09-25
- **Extends:** ADR 037 (member role management) and ADR 004
- **Extended:** 2026-09-25 by [ADR 047](047-workspace-membership-lifecycle.md),
  which adds leaving, suspension and ownership transfer
- **Amends:** ADR 038's rule that invitations never reactivate an inactive
  membership, for removed memberships only

## Context

ADR 037 lets owners and admins change an existing member's role but excludes
removal, suspension and ownership transfer. Team managers now need to take a
person out of a workspace. The product owner set the rules: owners may remove
any non-owner member; admins may remove only builder, operator or viewer
members; nobody removes themselves; the owner cannot be removed.

## Decision

Add one existing-member removal command owned by the identity/workspace
module, with the same shape, guards, locks and failure vocabulary as the ADR
037 role change.

- **Route:** `POST /v1/workspaces/{workspaceId}/members/{userId}/remove`,
  cookie session, double-submit CSRF, `Idempotency-Key`, `member:manage`
  route guard and the `ordinary_mutation` rate class. The strict body is
  `{ expectedRoleRevision }`; the 200 receipt is
  `{ userId, roleRevision, replayed }`. Errors are 400 malformed input, 401,
  403 for a forbidden actor or target (self, owner, peer admin), 404 for an
  unknown target after workspace authorization, and 409 for a stale revision
  (`workspace.member_role_revision_conflict`), a member who is no longer in the
  workspace (`workspace.member_removal_conflict`) or a reused key with another
  body (`request.idempotency_conflict`).
- **Policy:** `canRemoveWorkspaceMember` beside the role-transition policy in
  `workspace-policy.ts`. Owner removes admin, builder, operator and viewer;
  admin removes builder, operator and viewer; everybody else removes nobody.
  Active and suspended memberships can be removed; an already removed one is a
  conflict.
- **Revision fence:** the membership's existing monotonic `role_revision` is
  the precondition, so a removal decided on a stale snapshot (for example
  after a promotion to admin) fails instead of applying. Removal advances the
  revision.
- **Transaction:** the shared member-command path locks the workspace, then
  both users and memberships in identifier order, rechecks the active
  workspace and the actor's current authority, claims the
  actor/workspace/key-scoped receipt in
  `workspace_member_removal_command_receipts` (forced RLS, purged with the
  workspace), then marks the membership `removed`, revokes every platform
  session of the removed user in both session stores, appends one
  `workspace.member_removed` audit fact with bounded metadata (previous role,
  status and revisions) and completes the receipt — all in one commit. An
  exact retry returns the stored receipt without rechecking the old revision
  and without a second audit or revocation.
- **Row retention:** the membership row is kept with status `removed`. Access
  checks, workspace discovery and the member list already exclude it, and the
  single-owner index already ignores it. The API role gains no `DELETE`.
- **Invitations the removed user created stay as they are.** ADR 038 makes an
  invitation a workspace resource authorized when it was created; acceptance
  checks the invitation, recipient proof and workspace, not the inviter. This
  matches role changes, which also leave a demoted admin's invitations
  pending. Managers can revoke them from the Invitations tab.
- **Rejoining (ADR 038 amendment):** a later invitation accepted by a removed
  person makes the membership active again at the invited role, advances its
  revision and rotates sessions like a new membership. A suspended membership
  remains a conflict and is never reactivated by an invitation.

## Consequences

Removal takes effect on the next request: the revoked sessions fail
authentication and an open run-event stream closes within ADR 004's
five-second bound. Revocation is global to the removed person, as for role
changes, and the confirmation says so. Removal does not cancel runs the person
already started or undo external effects. Leaving a workspace (self-removal),
suspension and ownership transfer remain out of scope and need their own
decisions.

## Evidence

Disposable PostgreSQL suites cover the full actor/target matrix, self and
owner rejection, stale revisions, same-revision races with role changes, exact
and concurrent duplicate retries, rollback on a late audit failure, session
revocation in both stores, kept invitations and rejoining. The Better
Auth-only real-API suite covers CSRF, strict bodies, replay, stale and
repeated removals and the next-request 401 through the HTTP stack.
