import { capabilityGuard } from '../workspaces/http/guards.js';

export const VARIABLES_AUTHORIZATION = Symbol('VARIABLES_AUTHORIZATION');
export const WorkspaceVariablesReadGuard = capabilityGuard(
  VARIABLES_AUTHORIZATION,
  'workspace:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active', 'suspended', 'pending_deletion'],
  },
);
export const WorkspaceVariablesManageGuard = capabilityGuard(
  VARIABLES_AUTHORIZATION,
  'variable:manage',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
