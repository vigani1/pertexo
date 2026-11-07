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

export type AuthoringPersistence<
  Method extends keyof WorkflowAuthoringPersistence,
> = Pick<WorkflowAuthoringPersistence, Method>;

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

/** Authoring reads remain browsable during suspension; changes require active status. */
export async function authorizeAuthoringOperation(
  input: WorkflowApplicationInput & { signal?: AbortSignal },
  capability:
    | 'workflow:read'
    | 'workflow:update'
    | 'workflow:publish'
    | 'governance:manage',
  access: WorkspaceAuthorizationSource,
): Promise<void> {
  await authorizeWorkspaceOperation({
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability,
    access,
    disclosure: 'not_found',
    allowedWorkspaceStatuses:
      capability === 'workflow:read'
        ? BROWSABLE_WORKSPACE_STATUSES
        : ['active'],
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.authorizedWorkspace === undefined
      ? {}
      : { authorizedWorkspace: input.authorizedWorkspace }),
  });
}
