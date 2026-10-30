import { BROWSABLE_WORKSPACE_STATUSES } from '../authorization/index.js';
import { capabilityGuard } from '../workspaces/http/guards.js';

import { NOTIFICATION_AUTHORIZATION } from './tokens.js';

/** ADR 055, narrowed by ADR 013/027: a suspended workspace's inbox still reads. */
export const NotificationReadGuard = capabilityGuard(
  NOTIFICATION_AUTHORIZATION,
  'workspace:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);

/** Marking read and changing preferences need an active workspace. */
export const NotificationChangeGuard = capabilityGuard(
  NOTIFICATION_AUTHORIZATION,
  'workspace:read',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
