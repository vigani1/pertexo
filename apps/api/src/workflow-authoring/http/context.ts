import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';

import type { WorkflowAuthoringRequest } from '../workflow-transport.js';

export function requestContext(
  request: WorkflowAuthoringRequest,
  workspaceId: string,
) {
  return projectAuthenticatedWorkspaceContext(request, workspaceId);
}
