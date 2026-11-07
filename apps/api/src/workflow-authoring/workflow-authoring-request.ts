import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';

export type WorkflowAuthoringRequest = AbortableRequest &
  Readonly<
    Pick<
      IdentityWorkspaceRequest,
      | 'authorizedWorkspace'
      | 'cookies'
      | 'headers'
      | 'identitySession'
      | 'method'
      | 'params'
      | 'query'
      | 'requestId'
      | 'traceId'
    >
  >;

export interface WorkflowResponse {
  header(name: string, value: string): unknown;
}
export type ConditionalWorkflowResponse = WorkflowResponse &
  Readonly<{ status(code: number): unknown }>;
