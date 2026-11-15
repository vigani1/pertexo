import type { IdentityWorkspaceRequest } from '../../workspaces/workspace-transport.js';

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
