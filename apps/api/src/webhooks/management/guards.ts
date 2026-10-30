import { BROWSABLE_WORKSPACE_STATUSES } from '../../authorization/index.js';
import { capabilityGuard } from '../../workspaces/http/guards.js';

import { WEBHOOK_AUTHORIZATION } from '../tokens.js';

export const WebhookReadGuard = capabilityGuard(
  WEBHOOK_AUTHORIZATION,
  'workflow:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);

export const WebhookUpdateGuard = capabilityGuard(
  WEBHOOK_AUTHORIZATION,
  'workflow:update',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
