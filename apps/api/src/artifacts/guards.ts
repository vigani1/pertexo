import { BROWSABLE_WORKSPACE_STATUSES } from '../authorization/index.js';
import { capabilityGuard } from '../workspaces/http/guards.js';

import { ARTIFACT_AUTHORIZATION } from './tokens.js';

export const ArtifactUploadGuard = capabilityGuard(
  ARTIFACT_AUTHORIZATION,
  'artifact:upload',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

export const ArtifactReadGuard = capabilityGuard(
  ARTIFACT_AUTHORIZATION,
  'artifact:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);

/** Members who may send a form response: the same check as submitting it. */
export const FormResponderGuard = capabilityGuard(
  ARTIFACT_AUTHORIZATION,
  'workspace:read',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);

/** Task eligibility is rechecked per upload; this admits members who may read runs. */
export const InputRequestResponderGuard = capabilityGuard(
  ARTIFACT_AUTHORIZATION,
  'run:read',
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
