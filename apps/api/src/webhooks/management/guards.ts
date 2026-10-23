import { capabilityGuard } from '../../workspaces/http/guards.js';

import { WEBHOOK_AUTHORIZATION } from '../tokens.js';

export const WebhookReadGuard = capabilityGuard(
  WEBHOOK_AUTHORIZATION,
  'workflow:read',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

export const WebhookUpdateGuard = capabilityGuard(
  WEBHOOK_AUTHORIZATION,
  'workflow:update',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
