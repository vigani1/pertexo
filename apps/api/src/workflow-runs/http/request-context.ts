import type { IdentityWorkspaceRequest } from '../../workspaces/types.js';
import {
  optionalAuthorizedWorkspace,
  projectAuthenticatedWorkspaceContext,
} from '../../workspaces/request/authenticated-context.js';

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

function actorFrom(request: WorkflowRunsRequest, workspaceId: string) {
  return projectAuthenticatedWorkspaceContext(request, workspaceId).actor;
}

/** Who is asking, in which workspace, with what the guard already proved. */
export function caller(
  request: WorkflowRunsRequest,
  { workspaceId }: Readonly<{ workspaceId: string }>,
) {
  return {
    actor: actorFrom(request, workspaceId),
    routeWorkspaceId: workspaceId,
    ...optionalAuthorizedWorkspace(request),
  };
}
