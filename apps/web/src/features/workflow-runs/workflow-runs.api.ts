import {
  workflowRunCancelRequestSchema,
  workflowRunCancelResponseSchema,
  workflowRunListQuerySchema,
  workflowRunListResponseSchema,
  workflowRunReplayRequestSchema,
  workflowRunResponseSchema,
  workflowRunStartRequestSchema,
  workflowRunStartResponseSchema,
  workflowRunStatisticsQuerySchema,
  workflowRunStatisticsResponseSchema,
  type WorkflowRunCancelResponse,
  type WorkflowRunListResponse,
  type WorkflowRunResponse,
  type WorkflowRunStartResponse,
  type WorkflowRunStatisticsQuery,
  type WorkflowRunStatisticsResponse,
} from '@pertexo/contracts/schemas/workflow-runs';
import type { ApiByteStream, ApiClient } from '@/lib/api/client';
import type { RunHistoryFilters } from './model/run-search';
import { searchParams } from '@/lib/api/pagination';

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
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/runs?${searchParams(parsed)}`,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    response: {
      kind: 'json',
      decode: (value) => workflowRunListResponseSchema.parse(value),
    },
  });
}

/** Exact counts for one server snapshot: current, windowed, per workflow. */
export function getWorkflowRunStatistics(
  apiClient: ApiClient,
  workspaceId: string,
  query: WorkflowRunStatisticsQuery,
  signal?: AbortSignal,
): Promise<WorkflowRunStatisticsResponse> {
  const parsed = workflowRunStatisticsQuerySchema.parse(query);
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/run-statistics?${searchParams(parsed)}`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => workflowRunStatisticsResponseSchema.parse(value),
    },
  });
}

/**
 * Every run created since an instant, newest first, up to `cap` runs. Says
 * whether more existed so callers can state the cap instead of hiding it.
 */
export async function getRunsSince(
  apiClient: ApiClient,
  workspaceId: string,
  createdAtFrom: string,
  input: Readonly<{ cap: number; signal?: AbortSignal }>,
): Promise<
  Readonly<{ runs: WorkflowRunListResponse['items']; capped: boolean }>
> {
  const runs: WorkflowRunListResponse['items'][number][] = [];
  let after: string | undefined;
  while (runs.length < input.cap) {
    const page = await getWorkflowRunsPage(
      apiClient,
      workspaceId,
      { createdAtFrom },
      {
        limit: Math.min(100, input.cap - runs.length),
        ...(after === undefined ? {} : { after }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    runs.push(...page.items);
    if (page.nextCursor === null || page.nextCursor === after)
      return { runs, capped: false };
    after = page.nextCursor;
  }
  return { runs, capped: true };
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
