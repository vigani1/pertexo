import type { Role } from '@pertexo/workflow-model';

import type { DirectoryRole } from './contract.js';

export type ProjectedMember = Readonly<{
  role: Role;
  status: string;
  role_revision: number;
  directory_user_id: string | null;
}>;

export type MemberProjection =
  | Readonly<{ kind: 'leave' }>
  | Readonly<{ kind: 'add' }>
  | Readonly<{
      kind: 'change';
      status: 'active' | 'removed';
      roleRevision: number;
    }>;

/** What a directory user means for their membership in one linked workspace. */
export function projectMember({
  member,
  user,
  workspaceActive,
  role,
}: Readonly<{
  member: ProjectedMember | undefined;
  user: Readonly<{ id: string; active: boolean; deleted_at: Date | null }>;
  workspaceActive: boolean;
  role: DirectoryRole;
}>): MemberProjection {
  // Manual grants, including removed ones, are never adopted implicitly.
  if (
    member !== undefined &&
    (member.directory_user_id !== user.id || member.role === 'owner')
  )
    return { kind: 'leave' };
  const status =
    workspaceActive && user.active && user.deleted_at === null
      ? 'active'
      : 'removed';
  if (member === undefined)
    return status === 'active' ? { kind: 'add' } : { kind: 'leave' };
  if (member.role === role && member.status === status)
    return { kind: 'leave' };
  return { kind: 'change', status, roleRevision: member.role_revision + 1 };
}
