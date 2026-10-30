import { BROWSABLE_WORKSPACE_STATUSES } from '../../authorization/index.js';
import { capabilityGuard } from '../../workspaces/http/guards.js';

import { CONNECTION_AUTHORIZATION } from '../tokens.js';

export const ConnectionManageGuard = capabilityGuard(
  CONNECTION_AUTHORIZATION,
  'connection:manage',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

export const ConnectionReadGuard = capabilityGuard(
  CONNECTION_AUTHORIZATION,
  'connection:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);

export const ConnectionUseGuard = capabilityGuard(
  CONNECTION_AUTHORIZATION,
  'connection:use',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

export const FailureNotificationWorkflowEditGuard = capabilityGuard(
  CONNECTION_AUTHORIZATION,
  'workflow:update',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

/** Reading alert destinations and a workflow's alert policy, as an editor may. */
export const FailureNotificationReadGuard = capabilityGuard(
  CONNECTION_AUTHORIZATION,
  'workflow:update',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);
