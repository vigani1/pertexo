import type { WorkspaceMember } from '@pertexo/contracts';
import { WORKSPACE_ROLES, type WorkspaceRole } from './workspace-roles';

/** What each role may do, in one line under its group's heading. */
export const ROLE_SUMMARIES: Readonly<Record<WorkspaceRole, string>> = {
  owner:
    'Everything, including renaming, deleting and handing over the workspace.',
  admin: 'Everything except renaming, deleting or handing over the workspace.',
  builder: 'Builds, tests and publishes workflows, and starts runs.',
  operator: 'Starts and watches runs, but doesn’t change workflows.',
  viewer: 'Sees workflows and runs, and changes nothing.',
};

export type MemberGroup = Readonly<{
  role: WorkspaceRole;
  members: readonly WorkspaceMember[];
}>;

/**
 * Members grouped by role, most powerful first, keeping only those whose
 * name or email holds the search. Empty groups are left out.
 */
export function groupMembers(
  members: readonly WorkspaceMember[],
  search: string,
): readonly MemberGroup[] {
  const needle = search.trim().toLocaleLowerCase();
  const matching = members.filter(
    (member) =>
      needle === '' ||
      member.displayName.toLocaleLowerCase().includes(needle) ||
      member.email.toLocaleLowerCase().includes(needle),
  );
  return WORKSPACE_ROLES.map((role) => ({
    role,
    members: matching.filter((member) => member.role === role),
  })).filter((group) => group.members.length > 0);
}
