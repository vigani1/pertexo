import { BROWSABLE_WORKSPACE_STATUSES } from '../../authorization/index.js';
import { capabilityGuard } from '../../workspaces/http/guards.js';

import { WORKFLOW_AUTHORING_AUTHORIZATION } from '../tokens.js';

export const WorkflowPauseDefaultGuard = capabilityGuard(
  WORKFLOW_AUTHORING_AUTHORIZATION,
  'workspace:manage',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

export const WorkspaceAutoPauseReadGuard = capabilityGuard(
  WORKFLOW_AUTHORING_AUTHORIZATION,
  'workspace:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
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
export const WorkflowEditorReadGuard = capabilityGuard(
  WORKFLOW_AUTHORING_AUTHORIZATION,
  'workflow:update',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);

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

export const WorkflowReviewGuard = capabilityGuard(
  WORKFLOW_AUTHORING_AUTHORIZATION,
  'governance:manage',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
