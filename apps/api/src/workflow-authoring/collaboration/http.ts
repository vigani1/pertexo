import { withRequestOperationSignal } from '../../platform/http/index.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import type { WorkflowAuthoringRequest } from '../workflow-transport.js';

export async function collaborationOperation<
  Route extends { workspaceId: string },
  T,
>(
  request: WorkflowAuthoringRequest,
  route: Route,
  operation: (
    scope: ReturnType<typeof projectAuthenticatedWorkspaceContext> & {
      routeWorkspaceId: string;
      signal: AbortSignal;
    },
    route: Route,
  ) => Promise<T>,
) {
  const workspaceId = route.workspaceId;
  return await withRequestOperationSignal(request, (signal) =>
    operation(
      {
        ...projectAuthenticatedWorkspaceContext(request, workspaceId),
        routeWorkspaceId: workspaceId,
        signal,
      },
      route,
    ),
  );
}
