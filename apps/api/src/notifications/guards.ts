import { capabilityGuard } from '../workspaces/http/guards.js';

import { NOTIFICATION_AUTHORIZATION } from './tokens.js';

/** ADR 055: the inbox is readable only in an active workspace. */
export const NotificationReadGuard = capabilityGuard(
  NOTIFICATION_AUTHORIZATION,
  'workspace:read',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
