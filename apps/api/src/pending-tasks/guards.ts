import { BROWSABLE_WORKSPACE_STATUSES } from '../authorization/index.js';
import { capabilityGuard } from '../workspaces/http/guards.js';

export const TASK_AUTHORIZATION = Symbol('TASK_AUTHORIZATION');
export const PendingTaskReadGuard = capabilityGuard(
  TASK_AUTHORIZATION,
  'run:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);
/** Deciding and submitting need an active workspace; eligibility is per task. */
export const PendingTaskRespondGuard = capabilityGuard(
  TASK_AUTHORIZATION,
  'run:read',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
export const ApprovalAudienceReadGuard = capabilityGuard(
  TASK_AUTHORIZATION,
  'workflow:update',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);
export const ApprovalAudienceGuard = capabilityGuard(
  TASK_AUTHORIZATION,
  'workflow:update',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
