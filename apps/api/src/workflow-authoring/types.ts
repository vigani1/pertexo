import {
  workflowCreateRequestSchema,
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowDraftSaveRequestSchema,
  workflowIdParamSchema,
  workflowListQuerySchema,
  workflowListResponseSchema,
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
} from '@pertexo/contracts/workflow-authoring';
import type { IdentityWorkspaceRequest } from '../identity-workspace/types.js';

export {
  workflowCreateRequestSchema,
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowDraftSaveRequestSchema,
  workflowIdParamSchema,
  workflowListQuerySchema,
  workflowListResponseSchema,
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

export type WorkflowAuthoringRequest = Readonly<
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
