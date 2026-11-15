import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import type { WorkflowAuthoringRequest } from '../workflow-authoring-request.js';

/** Who asks, in which workspace: what every settings service starts from. */
export function asker(
  request: WorkflowAuthoringRequest,
  { workspaceId }: Readonly<{ workspaceId: string }>,
) {
  return {
    ...projectAuthenticatedWorkspaceContext(request, workspaceId),
    routeWorkspaceId: workspaceId,
  };
}
