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
