import {
  workflowCreateRequestSchema,
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowDraftSaveRequestSchema,
  workflowIdParamSchema,
  workflowListResponseSchema,
  workflowSummaryResponseSchema,
  workflowPublishResponseSchema,
  workflowValidateResponseSchema,
  workflowVersionResponseSchema,
  workflowVersionsQuerySchema,
  workflowVersionsResponseSchema,
  type WorkflowPublishResponse,
  type WorkflowValidateResponse,
  type WorkflowVersionResponse,
  type WorkflowVersionsResponse,
  type WorkflowSummary,
} from '@pertexo/contracts';
import type { IdentityWorkspaceRequest } from '../workspaces/types.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';

export {
  workflowCreateRequestSchema,
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowDraftSaveRequestSchema,
  workflowIdParamSchema,
  workflowListResponseSchema,
  workflowSummaryResponseSchema,
  workflowPublishResponseSchema,
  workflowValidateResponseSchema,
  workflowVersionResponseSchema,
  workflowVersionsQuerySchema,
  workflowVersionsResponseSchema,
};

export type {
  WorkflowPublishResponse,
  WorkflowValidateResponse,
  WorkflowVersionResponse,
  WorkflowVersionsResponse,
  WorkflowSummary,
};

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
