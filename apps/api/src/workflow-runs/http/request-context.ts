import type { IdentityWorkspaceRequest } from '../../workspaces/types.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';

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
  return projectAuthenticatedWorkspaceContext(request, workspaceId).actor;
}
