import type { Role } from '@pertexo/policy';

/** Raised when a flow's actor has no authority in the workspace it names. */
export class WorkspaceAccessDeniedError extends Error {
  public override readonly name = 'WorkspaceAccessDeniedError';
}

export function requireWorkspaceAuthority(role: Role | undefined): Role {
  if (role === undefined)
    throw new WorkspaceAccessDeniedError('Workspace access is unavailable');
  return role;
}
