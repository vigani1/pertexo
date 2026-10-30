import { BROWSABLE_WORKSPACE_STATUSES } from '../authorization/index.js';
import { capabilityGuard } from '../workspaces/http/guards.js';

export const FORM_AUTHORIZATION = Symbol('FORM_AUTHORIZATION');
export const FormMemberGuard = capabilityGuard(
  FORM_AUTHORIZATION,
  'workspace:read',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
export const FormManageGuard = capabilityGuard(
  FORM_AUTHORIZATION,
  'workflow:update',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
export const FormReadGuard = capabilityGuard(
  FORM_AUTHORIZATION,
  'workspace:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);
export const FormManagerReadGuard = capabilityGuard(
  FORM_AUTHORIZATION,
  'workflow:update',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);
