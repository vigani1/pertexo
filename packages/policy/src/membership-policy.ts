import { DELEGATED_ROLES, type Role } from './authorization-policy.js';

const administratorManagedRoles = DELEGATED_ROLES.filter(
  (role) => role !== 'admin',
);

/** ADR 037 role-transition policy, shared by UI projection and the database command. */
export function canChangeWorkspaceMemberRole(
  actorRole: Role,
  targetRole: Role,
  nextRole: Role,
): boolean {
  if (nextRole === 'owner' || targetRole === 'owner') return false;
  if (actorRole === 'owner') return true;
  return (
    actorRole === 'admin' &&
    administratorManagedRoles.some((role) => role === targetRole) &&
    administratorManagedRoles.some((role) => role === nextRole)
  );
}

/**
 * ADR 042 removal policy: owners remove any non-owner member, admins remove
 * only builder, operator or viewer members. Self-removal is decided by the
 * caller, which knows both identities.
 */
export function canRemoveWorkspaceMember(
  actorRole: Role,
  targetRole: Role,
): boolean {
  if (targetRole === 'owner') return false;
  if (actorRole === 'owner') return true;
  return (
    actorRole === 'admin' &&
    administratorManagedRoles.some((role) => role === targetRole)
  );
}

/**
 * ADR 047 suspension policy, for suspending and reactivating: the removal
 * matrix. Self-suspension is decided by the caller.
 */
export function canSuspendWorkspaceMember(
  actorRole: Role,
  targetRole: Role,
): boolean {
  return canRemoveWorkspaceMember(actorRole, targetRole);
}

/** ADR 047: only the owner hands the workspace to another member. */
export function canTransferWorkspaceOwnership(
  actorRole: Role,
  targetRole: Role,
): boolean {
  return actorRole === 'owner' && targetRole !== 'owner';
}

/** ADR 047: every member except the owner may leave. */
export function canLeaveWorkspace(role: Role): boolean {
  return role !== 'owner';
}

/** ADR 038 invitation policy. Current database state remains authoritative. */
export function canInviteWorkspaceRole(
  actorRole: Role,
  invitedRole: Role,
): boolean {
  if (invitedRole === 'owner') return false;
  if (actorRole === 'owner') return true;
  return (
    actorRole === 'admin' &&
    administratorManagedRoles.some((role) => role === invitedRole)
  );
}
