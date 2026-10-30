import { BROWSABLE_WORKSPACE_STATUSES } from '../authorization/index.js';
import { capabilityGuard } from '../workspaces/http/guards.js';

import { NODE_TESTING_AUTHORIZATION } from './tokens.js';

export const NodeTestingUpdateGuard = capabilityGuard(
  NODE_TESTING_AUTHORIZATION,
  'workflow:update',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

export const NodeSamplesReadGuard = capabilityGuard(
  NODE_TESTING_AUTHORIZATION,
  'workflow:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);
