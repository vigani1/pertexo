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
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
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
