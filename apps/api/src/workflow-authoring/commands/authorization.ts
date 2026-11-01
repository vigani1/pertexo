import {
  authorizeWorkspaceOperation,
  BROWSABLE_WORKSPACE_STATUSES,
  type AuthorizationCapability,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';

import type {
  WorkflowAuthoringPersistence,
  WorkflowApplicationInput,
} from '../ports.js';
import type { WorkflowDraftRecord } from '@pertexo/core/authoring';
import { WorkflowRevisionConflictError } from '@pertexo/core/authoring';

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

/** Reading a workflow, which a suspended workspace still allows (ADR 013/027). */
export async function authorizeWorkflowRead(
  input: WorkflowApplicationInput,
  access: WorkspaceAuthorizationSource,
): Promise<void> {
  await authorizeWorkspaceOperation({
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability: 'workflow:read',
    access,
    disclosure: 'not_found',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
    ...(input.authorizedWorkspace === undefined
      ? {}
      : { authorizedWorkspace: input.authorizedWorkspace }),
  });
}
