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
  { disclosure: 'not_found', allowedWorkspaceStatuses: ['active'] },
);
