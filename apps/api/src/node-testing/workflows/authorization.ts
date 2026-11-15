import {
  authorizeWorkspaceCapabilities,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';
import type { NodeTestServiceInput } from '../node-testing.service.js';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';
export type WorkflowTestServiceInput = Pick<
  NodeTestServiceInput,
  'actor' | 'routeWorkspaceId' | 'authorizedWorkspace' | 'workflowId'
> & { signal?: AbortSignal };
export function workflowTestScope(input: WorkflowTestServiceInput) {
  return {
    workspaceId: input.routeWorkspaceId,
    workflowId: input.workflowId,
    actorId: input.actor.actorId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}
export async function authorizeWorkflowTesting(
  authorization: WorkspaceAuthorizationSource,
  input: WorkflowTestServiceInput,
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
    allowedWorkspaceStatuses: ACTIVE_WORKSPACE_STATUSES,
    disclosure: 'not_found',
  });
}
