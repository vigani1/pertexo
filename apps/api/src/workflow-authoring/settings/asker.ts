import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import type { WorkflowAuthoringRequest } from '../types.js';

/** Who asks, in which workspace: what every settings use case starts from. */
export function asker(
  request: WorkflowAuthoringRequest,
  { workspaceId }: Readonly<{ workspaceId: string }>,
) {
  return {
    ...projectAuthenticatedWorkspaceContext(request, workspaceId),
    routeWorkspaceId: workspaceId,
  };
}
