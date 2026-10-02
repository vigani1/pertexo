import {
  AuthorizationError,
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../workspaces/index.js';
import type { WorkflowApplicationInput } from './ports.js';

export type WorkflowOrganizationInput = WorkflowApplicationInput &
  Readonly<{ signal?: AbortSignal }>;

/** Organization administration is owner/admin, not workspace:manage expansion.
 * Bulk callers request a fresh lookup for each item, never a retained guard proof. */
export async function authorizeWorkflowOrganization(
  input: WorkflowOrganizationInput,
  authorization: WorkspaceAuthorizationSource,
  role: 'read' | 'admin' | 'editor',
  fresh = false,
) {
  input.signal?.throwIfAborted();
  const access = await authorizeWorkspaceOperation({
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability: role === 'editor' ? 'workflow:update' : 'workflow:read',
    access: authorization,
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active'],
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(fresh || input.authorizedWorkspace === undefined
      ? {}
      : { authorizedWorkspace: input.authorizedWorkspace }),
  });
  if (role === 'admin' && access.role !== 'owner' && access.role !== 'admin')
    throw new AuthorizationError(
      'auth.forbidden',
      'Organization administration requires an owner or admin.',
    );
  input.signal?.throwIfAborted();
  return access;
}

export function workflowOrganizationContext(input: WorkflowOrganizationInput) {
  return {
    workspaceId: input.routeWorkspaceId,
    actorId: input.actor.actorId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}
