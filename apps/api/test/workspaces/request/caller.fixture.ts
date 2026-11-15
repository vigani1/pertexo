import { projectAuthenticatedWorkspaceContext } from '../../../src/workspaces/request/authenticated-context.js';
import type { WorkspaceCaller } from '../../../src/workspaces/request/caller.js';
import type { IdentityWorkspaceRequest } from '../../../src/workspaces/workspace-transport.js';

/**
 * The caller `@Caller()` hands a handler for `request` in `workspaceId`, for
 * tests that call a controller directly instead of through its route.
 */
export function workspaceCallerFor(
  request: IdentityWorkspaceRequest,
  workspaceId: string,
): WorkspaceCaller {
  return {
    workspaceId,
    ...projectAuthenticatedWorkspaceContext(request, workspaceId),
  };
}
