import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { WorkflowAuthoringRequest } from '../workflow-authoring-request.js';
import {
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

export async function collaborationOperation<
  Route extends { workspaceId: string },
  T,
>(
  request: WorkflowAuthoringRequest,
  caller: WorkspaceCaller,
  route: Route,
  operation: (
    scope: ReturnType<typeof serviceCaller> & {
      signal: AbortSignal;
    },
    route: Route,
  ) => Promise<T>,
) {
  return await withRequestOperationSignal(request, (signal) =>
    operation(
      {
        ...serviceCaller(caller),
        signal,
      },
      route,
    ),
  );
}
