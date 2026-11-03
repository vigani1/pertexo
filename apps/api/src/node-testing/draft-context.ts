import { projectAuthenticatedWorkspaceContext } from '../workspaces/request/authenticated-context.js';
import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';

export type DraftRequest = IdentityWorkspaceRequest & AbortableRequest;

/** Who is asking, about which workflow's draft. */
export function draftContext(
  request: DraftRequest,
  {
    workspaceId,
    workflowId,
  }: Readonly<{ workspaceId: string; workflowId: string }>,
) {
  return {
    ...projectAuthenticatedWorkspaceContext(request, workspaceId),
    routeWorkspaceId: workspaceId,
    workflowId,
  };
}
