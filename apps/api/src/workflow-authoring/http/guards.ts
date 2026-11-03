import { BROWSABLE_WORKSPACE_STATUSES } from '../../authorization/index.js';
import { capabilityGuard } from '../../workspaces/http/guards.js';

import { WORKFLOW_AUTHORING_AUTHORIZATION } from '../tokens.js';

export const WorkflowPauseDefaultGuard = capabilityGuard(
  WORKFLOW_AUTHORING_AUTHORIZATION,
  'workspace:manage',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

export const WorkflowReadGuard = capabilityGuard(
  WORKFLOW_AUTHORING_AUTHORIZATION,
  'workflow:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);

/** Reads only an editor may make, such as promotion candidates. */
/** Changes any reader may make, such as commenting: never while suspended. */
export const WorkflowParticipantGuard = capabilityGuard(
  WORKFLOW_AUTHORING_AUTHORIZATION,
  'workflow:read',
);

export const WorkflowCreateGuard = capabilityGuard(
  WORKFLOW_AUTHORING_AUTHORIZATION,
  'workflow:create',
);

export const WorkflowUpdateGuard = capabilityGuard(
  WORKFLOW_AUTHORING_AUTHORIZATION,
  'workflow:update',
);

export const WorkflowPublishGuard = capabilityGuard(
  WORKFLOW_AUTHORING_AUTHORIZATION,
  'workflow:publish',
);
