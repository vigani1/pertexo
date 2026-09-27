import type { IdentityWorkspaceRequest } from '../identity-workspace/types.js';
import { projectAuthenticatedWorkspaceContext } from '../identity-workspace/authenticated-command-context.js';
import { applicationError } from '../platform/http/index.js';
import { throwWorkflowRunError } from './errors.js';

export type WorkflowRunsRequest = Readonly<
  Pick<
    IdentityWorkspaceRequest,
    | 'authorizedWorkspace'
    | 'cookies'
    | 'headers'
    | 'identitySession'
    | 'method'
    | 'reauthorizeIdentitySession'
    | 'requestId'
    | 'traceId'
  > & {
    raw?: Readonly<{
      once(event: 'close', listener: () => void): unknown;
      off(event: 'close', listener: () => void): unknown;
    }>;
  }
>;

export function actorFrom(request: WorkflowRunsRequest, workspaceId: string) {
  try {
    return projectAuthenticatedWorkspaceContext(request, workspaceId).actor;
  } catch (error: unknown) {
    return throwWorkflowRunError(
      applicationError('request.invalid', {
        safeDetail:
          error instanceof Error ? error.message : 'Invalid actor context',
      }),
    );
  }
}
