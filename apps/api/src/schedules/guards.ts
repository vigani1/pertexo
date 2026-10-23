import { capabilityGuard } from '../workspaces/http/guards.js';

import { SCHEDULE_AUTHORIZATION } from './tokens.js';

export const ScheduleReadGuard = capabilityGuard(
  SCHEDULE_AUTHORIZATION,
  'workflow:read',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

export const ScheduleUpdateGuard = capabilityGuard(
  SCHEDULE_AUTHORIZATION,
  'workflow:update',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
