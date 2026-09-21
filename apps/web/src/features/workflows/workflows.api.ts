import {
  strongEtagSchema,
  workflowCreateRequestSchema,
  workflowCreateResponseSchema,
  workflowListResponseSchema,
  workflowSummaryResponseSchema,
  type WorkflowCreateResponse,
  type WorkflowListResponse,
  type WorkflowListQuery,
  type WorkflowSummary,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type { ApiClient } from '@/lib/api/client';

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

export async function findWorkflowSummary(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowSummary | null> {
  let after: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 40; page += 1) {
    const response = await getWorkflowsPage(apiClient, workspaceId, {
      ...(after === undefined ? {} : { after }),
      ...(signal === undefined ? {} : { signal }),
    });
    const match = response.items.find((item) => item.id === workflowId);
    if (match !== undefined) return match;
    if (response.nextCursor === null) return null;
    if (seen.has(response.nextCursor))
      throw new Error('Workflow pagination repeated a cursor.');
    seen.add(response.nextCursor);
    after = response.nextCursor;
  }
  throw new Error('Workflow lookup exceeded its bounded page limit.');
}

export async function getWorkflowSummary(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowSummary> {
  const response = await apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}`,
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
