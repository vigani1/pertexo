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
} from '@pertexo/contracts';
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
