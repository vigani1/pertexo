import { capabilityGuard } from '../workspaces/http/guards.js';

export const TABLE_AUTHORIZATION = Symbol('TABLE_AUTHORIZATION');
export const DataTablesReadGuard = capabilityGuard(
  TABLE_AUTHORIZATION,
  'workspace:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active', 'suspended', 'pending_deletion'],
  },
);
export const DataTablesManageGuard = capabilityGuard(
  TABLE_AUTHORIZATION,
  'workflow:update',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
