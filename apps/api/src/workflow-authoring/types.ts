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
  type WorkflowValidateResponse,
  type WorkflowVersionResponse,
  type WorkflowVersionsResponse,
  type WorkflowSummary,
  type WorkflowGraphContract,
} from '@pertexo/contracts';
import { idempotencyKeySchema } from '@pertexo/contracts/identity-workspace';
import type { AuthorizedWorkspaceContext } from '../workspaces/index.js';

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
  authorizedWorkspace?: AuthorizedWorkspaceContext;
}>;

export interface WorkflowResponse {
  header(name: string, value: string): unknown;
}

type WorkflowRouteParams = Readonly<{
  workspaceId: string;
  workflowId: string;
}>;

type WorkflowWorkspaceParams = Readonly<{ workspaceId: string }>;

type WorkflowListQuery = Readonly<{
  limit?: number;
  after?: string;
}>;

type WorkflowVersionsQuery = WorkflowListQuery;

type WorkflowGraphInput = WorkflowGraphContract;
