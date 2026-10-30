import { BROWSABLE_WORKSPACE_STATUSES } from '../../authorization/index.js';
import { capabilityGuard } from '../../workspaces/http/guards.js';

import { WORKFLOW_RUN_AUTHORIZATION } from '../tokens.js';

export const UsageCapacityArtifactReadGuard = capabilityGuard(
  WORKFLOW_RUN_AUTHORIZATION,
  'artifact:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);

export const WorkflowRunReadGuard = capabilityGuard(
  WORKFLOW_RUN_AUTHORIZATION,
  'run:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active', 'suspended', 'pending_deletion'],
  },
);

export const WorkflowRunStartGuard = capabilityGuard(
  WORKFLOW_RUN_AUTHORIZATION,
  'run:start',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

export const WorkflowRunReplayGuard = capabilityGuard(
  WORKFLOW_RUN_AUTHORIZATION,
  'run:replay',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

export const WorkflowRunCancelGuard = capabilityGuard(
  WORKFLOW_RUN_AUTHORIZATION,
  'run:cancel',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active', 'suspended', 'pending_deletion'],
  },
);
