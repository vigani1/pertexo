# ADR 037: Bounded workspace member role management

- **Status:** accepted
- **Date:** 2026-09-15

## Decision

Extend ADR 004 with role changes for existing active workspace members only.
The user approved this scope and transition policy: owners may change another
non-owner member to admin, builder, operator or viewer; admins may change only
builder/operator/viewer members among those three roles. No self-role changes,
owner promotion/demotion, ownership transfer, membership removal, suspension,
or invitations are included. Preserve the existing single-owner database
constraint and existing role-to-capability mapping.

The identity/workspace module owns the command. Authorization and the target's
current state are checked transactionally, not inferred from the member-list
snapshot. A monotonic role revision prevents stale/ABA changes, and durable
actor/workspace-scoped idempotency preserves exact uncertain retries. The role
change, revision, safe audit fact, command receipt and revocation of the
target user's active platform sessions commit together. Revocation requires
that user to sign in again across workspaces, consistent with ADR 004's
privilege-changing session boundary; the UI must state that consequence.
Existing per-request authorization and bounded SSE reauthorization remain in
force. This does not cancel already-accepted workflow runs or undo external
effects.

## Trade-offs and scope

Keeping owner changes and self-demotion out of this slice avoids introducing
ownership transfer or last-owner recovery semantics. Allowing admins to manage
only operational roles avoids granting them authority over peers or owners.
Revoking sessions is deliberately simpler and safer than adding a new session
rotation/privilege-epoch protocol in this slice, but affects all of the target
user's sessions rather than only this workspace.

Implementation details and acceptance gates are in the frontend plan's
“Implementation-ready slice: existing-member role management” section. This ADR
does not mark the command as implemented or authorize invitation delivery.
