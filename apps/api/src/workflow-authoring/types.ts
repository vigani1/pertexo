import {
  strongEtagSchema,
  workflowCreateRequestSchema,
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowDraftSaveRequestSchema,
  workflowIdParamSchema,
  workflowListQuerySchema,
  workflowListResponseSchema,
  workflowPublishResponseSchema,
  workflowRevisionConflictProblemSchema,
  workflowValidateResponseSchema,
  workflowVersionResponseSchema,
  workflowVersionsQuerySchema,
  workflowVersionsResponseSchema,
  workflowGraphSchema,
  type WorkflowCreateResponse,
  type WorkflowDraftResponse,
  type WorkflowPublishResponse,
  type WorkflowSummary,
  type WorkflowGraphContract,
} from '@pertexo/contracts';
import { idempotencyKeySchema } from '@pertexo/contracts/identity-workspace';

export {
  strongEtagSchema,
  workflowCreateRequestSchema,
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowDraftSaveRequestSchema,
  workflowIdParamSchema,
  workflowListQuerySchema,
  workflowListResponseSchema,
  workflowPublishResponseSchema,
  workflowRevisionConflictProblemSchema,
  workflowValidateResponseSchema,
  workflowVersionResponseSchema,
  workflowVersionsQuerySchema,
  workflowVersionsResponseSchema,
  workflowGraphSchema,
  idempotencyKeySchema,
};

export type {
  WorkflowCreateResponse,
  WorkflowDraftResponse,
  WorkflowPublishResponse,
  WorkflowSummary,
  WorkflowGraphContract,
};

export type WorkflowAuthoringRequest = Readonly<{
  method?: string;
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  cookies?: Readonly<Record<string, string | undefined>>;
  requestId?: string;
  traceId?: string;
  params?: unknown;
  query?: unknown;
  identitySession?: Readonly<{
    userId: string;
    sessionId: string;
    expiresAt: Date;
    clientMetadata: Readonly<Record<string, string>>;
  }>;
}>;

export interface WorkflowResponse {
  header(name: string, value: string): unknown;
}

export type WorkflowRouteParams = Readonly<{
  workspaceId: string;
  workflowId: string;
}>;

export type WorkflowWorkspaceParams = Readonly<{ workspaceId: string }>;

export type WorkflowListQuery = Readonly<{
  limit?: number;
  after?: string;
}>;

export type WorkflowVersionsQuery = WorkflowListQuery;

export type WorkflowGraphInput = WorkflowGraphContract;
