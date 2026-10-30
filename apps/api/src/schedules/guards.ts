import { BROWSABLE_WORKSPACE_STATUSES } from '../authorization/index.js';
import { capabilityGuard } from '../workspaces/http/guards.js';

import { SCHEDULE_AUTHORIZATION } from './tokens.js';

export const ScheduleReadGuard = capabilityGuard(
  SCHEDULE_AUTHORIZATION,
  'workflow:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);

/** Previewing belongs to editing a schedule, so it stays with active workspaces. */
export const SchedulePreviewGuard = capabilityGuard(
  SCHEDULE_AUTHORIZATION,
  'workflow:read',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

export const ScheduleUpdateGuard = capabilityGuard(
  SCHEDULE_AUTHORIZATION,
  'workflow:update',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
