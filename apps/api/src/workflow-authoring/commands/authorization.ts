import {
  authorizeWorkspaceOperation,
  type AuthorizationCapability,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';

import type {
  WorkflowAuthoringPersistence,
  WorkflowApplicationInput,
} from '../ports.js';
import type { WorkflowDraftRecord } from '@pertexo/database/authoring';
import { WorkflowRevisionConflictError } from '@pertexo/database/authoring';

export const ACTIVE_WORKFLOW_CAPABILITY = 'workflow:read' as const;

export type AuthoringPersistence<
  Method extends keyof WorkflowAuthoringPersistence,
> = Pick<WorkflowAuthoringPersistence, Method>;

export function revisionConflict(
  draft: WorkflowDraftRecord,
  currentEtag: string,
): WorkflowRevisionConflictError {
  return new WorkflowRevisionConflictError(draft.revision, currentEtag);
}

export async function authorize(
  input: WorkflowApplicationInput,
  capability: AuthorizationCapability,
  access: WorkspaceAuthorizationSource,
): Promise<void> {
  await authorizeWorkspaceOperation({
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability,
    access,
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active'],
    ...(input.authorizedWorkspace === undefined
      ? {}
      : { authorizedWorkspace: input.authorizedWorkspace }),
  });
}
