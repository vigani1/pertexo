import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import { withRequestOperationSignal } from '../../platform/http/request-operation-signal.js';
import type { WorkflowOrganizationInput } from './authority.js';
import { throwWorkflowApplicationError } from '../errors.js';
import type { WorkflowAuthoringRequest } from '../types.js';

/** Shared scoped cancellation/error translation, never manual HTTP formatting. */
export async function withWorkflowOrganizationRequest<T>(
  request: WorkflowAuthoringRequest,
  workspaceId: string,
  work: (input: WorkflowOrganizationInput) => Promise<T>,
): Promise<T> {
  try {
    return await withRequestOperationSignal(request, (signal) =>
      work({
        ...projectAuthenticatedWorkspaceContext(request, workspaceId),
        routeWorkspaceId: workspaceId,
        signal,
      }),
    );
  } catch (error: unknown) {
    return throwWorkflowApplicationError(error);
  }
}
