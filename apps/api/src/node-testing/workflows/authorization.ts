import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';
import type { NodeTestUseCaseInput } from '../use-case.js';
export type WorkflowTestUseCaseInput = Pick<
  NodeTestUseCaseInput,
  'actor' | 'routeWorkspaceId' | 'authorizedWorkspace' | 'workflowId'
> & { signal?: AbortSignal };
export function workflowTestScope(input: WorkflowTestUseCaseInput) {
  return {
    workspaceId: input.routeWorkspaceId,
    workflowId: input.workflowId,
    actorId: input.actor.actorId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}
export async function authorizeWorkflowTesting(
  authorization: WorkspaceAuthorizationSource,
  input: WorkflowTestUseCaseInput,
): Promise<void> {
  for (const capability of [
    'workflow:update',
    'run:read',
    'run:start',
  ] as const)
    await authorizeWorkspaceOperation({
      access: authorization,
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      ...(capability !== 'workflow:update' ||
      input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      capability,
      allowedWorkspaceStatuses: ['active'],
      disclosure: 'not_found',
    });
}
