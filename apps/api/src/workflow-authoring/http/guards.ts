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
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

export const WorkflowReadGuard = capabilityGuard(
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
