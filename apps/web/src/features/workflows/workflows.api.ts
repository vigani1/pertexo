import {
  strongEtagSchema,
  workflowCreateRequestSchema,
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowLifecycleRequestSchema,
  workflowLifecycleResponseSchema,
  workflowListResponseSchema,
  workflowSummaryResponseSchema,
  type WorkflowCreateResponse,
  type WorkflowGraphContract,
  type WorkflowLifecycleResponse,
  type WorkflowListResponse,
  type WorkflowListQuery,
  type WorkflowSummary,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type { ApiClient } from '@/lib/api/client';

function workflowPath(workspaceId: string, workflowId: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}`;
}

export function getWorkflowsPage(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<
    Pick<WorkflowListQuery, 'after' | 'limit' | 'order'> & {
      signal?: AbortSignal;
    }
  > = {},
): Promise<WorkflowListResponse> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 25) });
  if (input.after !== undefined) query.set('after', input.after);
  if (input.order !== undefined) query.set('order', input.order);
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows?${query.toString()}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => workflowListResponseSchema.parse(value),
    },
  });
}

export async function getWorkflowSummary(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowSummary> {
  const response = await apiClient.request({
    path: workflowPath(workspaceId, workflowId),
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => workflowSummaryResponseSchema.parse(value),
    },
  });
  return response.workflow;
}

export type CreatedWorkflow = Readonly<{
  body: WorkflowCreateResponse;
  draftEtag: string;
}>;

export function createWorkflow(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{
    name: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }>,
): Promise<CreatedWorkflow> {
  const request = workflowCreateRequestSchema.parse({ name: input.name });
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows`,
    method: 'POST',
    body: request,
    headers: { 'Idempotency-Key': input.idempotencyKey },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value, metadata) => ({
        body: workflowCreateResponseSchema.parse(value),
        draftEtag: strongEtagSchema.parse(metadata.header('etag')),
      }),
    },
  });
}

/**
 * The current draft's graph, read only to draw a workflow's shape in lists.
 * Saving drafts belongs to the editor, which also owns the draft's ETag.
 */
export async function getWorkflowShapeGraph(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowGraphContract> {
  const draft = await apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/draft`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => workflowDraftResponseSchema.parse(value),
    },
  });
  return draft.graph;
}

export type WorkflowLifecycleCommand = Readonly<{
  command: 'archive' | 'restore';
  expectedLifecycleRevision: number;
  idempotencyKey: string;
}>;

export function transitionWorkflowLifecycle(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  input: WorkflowLifecycleCommand,
): Promise<WorkflowLifecycleResponse> {
  return apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/${input.command}`,
    method: 'POST',
    headers: { 'Idempotency-Key': input.idempotencyKey },
    body: workflowLifecycleRequestSchema.parse({
      expectedLifecycleRevision: input.expectedLifecycleRevision,
    }),
    response: {
      kind: 'json',
      decode: (value) => workflowLifecycleResponseSchema.parse(value),
    },
  });
}
