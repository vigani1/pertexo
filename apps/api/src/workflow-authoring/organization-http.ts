import { WorkflowOrganizationUnavailableError } from '@pertexo/database/api';
import { projectAuthenticatedWorkspaceContext } from '../identity-workspace/authenticated-command-context.js';
import { withRequestOperationSignal } from '../platform/http/request-operation-signal.js';
import type { WorkflowOrganizationInput } from './organization-authority.js';
import { throwWorkflowApplicationError } from './errors.js';
import type { WorkflowAuthoringRequest } from './types.js';

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
export function requireWorkflowOrganization<T>(value: T | undefined): T {
  if (value === undefined) throw new WorkflowOrganizationUnavailableError();
  return value;
}
