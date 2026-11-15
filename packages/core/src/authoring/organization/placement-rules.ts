import { isAdministrativeRole, type Role } from '@pertexo/policy';
import type { OrganizationChange } from './placement.repository.js';

/**
 * Archived workflows keep their tags; only administrators move them between
 * folders. Tag detach is cleanup and works on any workflow.
 */
export function lifecycleAllowsChange(
  role: Role | null,
  lifecycleStatus: string,
  kind: OrganizationChange['kind'],
): boolean {
  if (lifecycleStatus === 'active' || kind === 'detach_tag') return true;
  return kind === 'move' && role !== null && isAdministrativeRole(role);
}
