import {
  authorizeWorkspaceCapabilities,
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
  await authorizeWorkspaceCapabilities({
    access: authorization,
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    ...(input.authorizedWorkspace === undefined
      ? {}
      : { authorizedWorkspace: input.authorizedWorkspace }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    capabilities: ['workflow:update', 'run:read', 'run:start'],
    allowedWorkspaceStatuses: ['active'],
    disclosure: 'not_found',
  });
}
