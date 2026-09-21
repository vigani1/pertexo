import {
  workflowRunCancelRequestSchema,
  workflowRunCancelResponseSchema,
  workflowRunListQuerySchema,
  workflowRunListResponseSchema,
  workflowRunReplayRequestSchema,
  workflowRunResponseSchema,
  workflowRunStartRequestSchema,
  workflowRunStartResponseSchema,
  type WorkflowRunCancelResponse,
  type WorkflowRunListResponse,
  type WorkflowRunResponse,
  type WorkflowRunStartResponse,
} from '@pertexo/contracts/schemas/workflow-runs';
import type { ApiByteStream, ApiClient } from '@/lib/api/client';
import type { RunHistoryFilters } from './run-history.types';

export function getWorkflowRunsPage(
  apiClient: ApiClient,
  workspaceId: string,
  filters: RunHistoryFilters,
  input: Readonly<{
    after?: string;
    limit?: number;
    signal?: AbortSignal;
  }> = {},
): Promise<WorkflowRunListResponse> {
  const parsed = workflowRunListQuerySchema.parse({
    limit: input.limit ?? 50,
    ...filters,
    ...(input.after === undefined ? {} : { after: input.after }),
  });
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(parsed))
    query.set(name, String(value));
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/runs?${query.toString()}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => workflowRunListResponseSchema.parse(value),
    },
  });
}

export function startWorkflowRun(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  input: Readonly<{
    value?: unknown;
    deadlineAt?: string;
    idempotencyKey: string;
  }>,
): Promise<WorkflowRunStartResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/runs`,
    method: 'POST',
    headers: { 'Idempotency-Key': input.idempotencyKey },
    body: workflowRunStartRequestSchema.parse({
      ...(input.value === undefined ? {} : { input: input.value }),
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
    }),
    response: {
      kind: 'json',
      decode: (value) => workflowRunStartResponseSchema.parse(value),
    },
  });
}

export function getWorkflowRun(
  apiClient: ApiClient,
  workspaceId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<WorkflowRunResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => workflowRunResponseSchema.parse(value),
    },
  });
}

export function openWorkflowRunEvents(
  apiClient: ApiClient,
  workspaceId: string,
  runId: string,
  lastEventId: number,
  signal: AbortSignal,
): Promise<ApiByteStream> {
  return apiClient.stream({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/events`,
    headers: { 'Last-Event-ID': String(lastEventId) },
    signal,
    response: { kind: 'stream', mediaType: 'text/event-stream' },
  });
}

export function cancelWorkflowRun(
  apiClient: ApiClient,
  workspaceId: string,
  runId: string,
  reason?: string,
): Promise<WorkflowRunCancelResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/cancel`,
    method: 'POST',
    body: workflowRunCancelRequestSchema.parse(
      reason === undefined || reason.trim() === '' ? {} : { reason },
    ),
    response: {
      kind: 'json',
      decode: (value) => workflowRunCancelResponseSchema.parse(value),
    },
  });
}

export function replayWorkflowRun(
  apiClient: ApiClient,
  workspaceId: string,
  sourceRunId: string,
  input: Readonly<{
    workflowVersionId: string;
    value: unknown;
    deadlineAt?: string;
    idempotencyKey: string;
  }>,
): Promise<WorkflowRunStartResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(sourceRunId)}/replay`,
    method: 'POST',
    headers: { 'Idempotency-Key': input.idempotencyKey },
    body: workflowRunReplayRequestSchema.parse({
      workflowVersionId: input.workflowVersionId,
      input: input.value,
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
    }),
    response: {
      kind: 'json',
      decode: (value) => workflowRunStartResponseSchema.parse(value),
    },
  });
}
