import type { AccessibleWorkspace } from '@pertexo/contracts';
import {
  hasCapability,
  isAdministrativeRole,
  type Role,
} from '@pertexo/policy';
export type RequiredRole = 'member' | 'editor' | 'admin';

const ROLE_ALLOWED: Readonly<Record<RequiredRole, (role: Role) => boolean>> = {
  member: () => true,
  editor: (role) => hasCapability(role, 'workflow:update'),
  admin: isAdministrativeRole,
};

export function allowed(
  workspace: AccessibleWorkspace | undefined,
  role: RequiredRole,
) {
  return (
    workspace?.status === 'active' &&
    workspace.capabilities.includes('workflow:read') &&
    ROLE_ALLOWED[role](workspace.role)
  );
}
