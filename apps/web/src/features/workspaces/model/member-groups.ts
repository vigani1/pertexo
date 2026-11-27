import type { WorkspaceMember } from '@pertexo/contracts';
import { WORKSPACE_ROLES, type WorkspaceRole } from './workspace-roles';

export type MemberGroup = Readonly<{
  role: WorkspaceRole;
  members: readonly WorkspaceMember[];
}>;

/**
 * Members grouped by role, most powerful first. Empty groups are left out.
 */
export function groupMembers(
  members: readonly WorkspaceMember[],
): readonly MemberGroup[] {
  return WORKSPACE_ROLES.map((role) => ({
    role,
    members: members.filter((member) => member.role === role),
  })).filter((group) => group.members.length > 0);
}
