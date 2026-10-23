import {
  authorizeWorkspaceOperation,
  type AuthorizationCapability,
  type WorkspaceAuthorizationSource,
  type WorkspaceStatus,
  type AuthorizedWorkspaceContext,
} from '../../authorization/index.js';
import type { WorkflowRunApplicationInput } from '../ports.js';

export class WorkflowRunNotFoundError extends Error {
  public override readonly name = 'WorkflowRunNotFoundError';
}

export async function authorize(
  input: WorkflowRunApplicationInput,
  capability: AuthorizationCapability,
  access: WorkspaceAuthorizationSource,
  allowedWorkspaceStatuses: readonly WorkspaceStatus[],
): Promise<AuthorizedWorkspaceContext> {
  return authorizeWorkspaceOperation({
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability,
    access,
    disclosure: 'not_found',
    allowedWorkspaceStatuses,
    ...(input.authorizedWorkspace === undefined
      ? {}
      : { authorizedWorkspace: input.authorizedWorkspace }),
  });
}
