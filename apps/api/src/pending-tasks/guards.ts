import { capabilityGuard } from '../workspaces/http/guards.js';

export const TASK_AUTHORIZATION = Symbol('TASK_AUTHORIZATION');
export const PendingTaskReadGuard = capabilityGuard(
  TASK_AUTHORIZATION,
  'run:read',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
export const ApprovalAudienceGuard = capabilityGuard(
  TASK_AUTHORIZATION,
  'workflow:update',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
