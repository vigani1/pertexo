import { workflowRunKeys } from './query-cache';
import { QUERY_FRESHNESS, QUERY_RETENTION } from '@/lib/api/query-timings';
import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import {
  getWorkflowNodeRunInput,
  getWorkflowNodeRunDiagnostics,
  getWorkflowNodeRunOutput,
  getWorkflowRunInput,
  getWorkflowRunVariables,
} from './workflow-runs.api';

/*
 * Stored run data (ADR 050, 052): a run's input and each step run's input
 * and output, kept apart from the run detail so live events don't refetch it.
 */

/** A run's stored input; it never changes, so it's read once. */
export function workflowRunInputQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  runId: string,
) {
  return queryOptions({
    queryKey: [...workflowRunKeys.data(userId, workspaceId, runId), 'input'],
    queryFn: ({ signal }) =>
      getWorkflowRunInput(apiClient, workspaceId, runId, signal),
    staleTime: QUERY_FRESHNESS.immutable,
  });
}

/**
 * A step run's output. It only changes when the step does, so the step's
 * status is part of the key: a step that finishes is read again.
 */
export function nodeRunOutputQueryOptions({
  apiClient,
  userId,
  workspaceId,
  runId,
  step,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  runId: string;
  step: Readonly<{ nodeRunId: string; status: string }>;
}>) {
  return queryOptions({
    queryKey: [
      ...workflowRunKeys.data(userId, workspaceId, runId),
      'output',
      step.nodeRunId,
      step.status,
    ],
    queryFn: ({ signal }) =>
      getWorkflowNodeRunOutput({
        apiClient,
        workspaceId,
        runId,
        nodeRunId: step.nodeRunId,
        signal,
      }),
    staleTime: QUERY_FRESHNESS.immutable,
  });
}

/** Reads, the first included, while a running attempt hasn't recorded yet. */
const INPUT_RECORDING_READS = 5;
// Recording polls back off from one second, doubling each read.
const INPUT_RECORDING_FIRST_WAIT_MS = 1_000;
const INPUT_RECORDING_BACKOFF = 2;

/**
 * When to read a running step's recorded input again, or false to stop. A
 * failed refetch keeps the last empty answer, so it stops there and the
 * visible retry action, not a successful-read counter, owns recovery.
 */
function nextRecordingRead(
  input: Readonly<{
    running: boolean;
    failed: boolean;
    empty: boolean;
    reads: number;
  }>,
): number | false {
  if (input.failed || !input.running || !input.empty) return false;
  if (input.reads >= INPUT_RECORDING_READS) return false;
  return (
    INPUT_RECORDING_FIRST_WAIT_MS * INPUT_RECORDING_BACKOFF ** (input.reads - 1)
  );
}

/**
 * What a step run's current attempt received (ADR 052). A recording belongs
 * to one attempt, so each attempt, and each status it reaches, reads again;
 * a settled read stays cached. The worker records the input just after the
 * attempt starts, so while it runs with nothing recorded, the read repeats a
 * few times at a widening interval, then waits for the next status.
 */
export function nodeRunInputQueryOptions({
  apiClient,
  userId,
  workspaceId,
  runId,
  step,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  runId: string;
  step: Readonly<{
    nodeRunId: string;
    attemptNumber: number | undefined;
    status: string;
  }>;
}>) {
  return queryOptions({
    queryKey: [
      ...workflowRunKeys.data(userId, workspaceId, runId),
      'input-of',
      step.nodeRunId,
      step.attemptNumber ?? null,
      step.status,
    ],
    queryFn: ({ signal }) =>
      getWorkflowNodeRunInput({
        apiClient,
        workspaceId,
        runId,
        nodeRunId: step.nodeRunId,
        signal,
      }),
    staleTime: QUERY_FRESHNESS.immutable,
    refetchInterval: (query) =>
      nextRecordingRead({
        running: step.status === 'running',
        failed: query.state.status === 'error',
        empty: query.state.data?.kind === 'none',
        reads: query.state.dataUpdateCount,
      }),
  });
}

export function workflowRunVariablesQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  runId: string,
) {
  return queryOptions({
    queryKey: [
      ...workflowRunKeys.data(userId, workspaceId, runId),
      'variables',
    ],
    queryFn: ({ signal }) =>
      getWorkflowRunVariables(apiClient, workspaceId, runId, signal),
    staleTime: QUERY_FRESHNESS.immutable,
    gcTime: QUERY_RETENTION.none,
    retry: false,
  });
}

/** A terminal attempt's private diagnostics; a new attempt or status reads again. */
export function nodeRunDiagnosticsQueryOptions({
  apiClient,
  userId,
  workspaceId,
  runId,
  step,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  runId: string;
  step: Readonly<{
    nodeRunId: string;
    attemptNumber: number | undefined;
    status: string;
  }>;
}>) {
  return queryOptions({
    queryKey: [
      ...workflowRunKeys.data(userId, workspaceId, runId),
      'diagnostics',
      step.nodeRunId,
      step.attemptNumber ?? null,
      step.status,
    ],
    queryFn: ({ signal }) =>
      getWorkflowNodeRunDiagnostics({
        apiClient,
        workspaceId,
        runId,
        nodeRunId: step.nodeRunId,
        attemptNumber: step.attemptNumber,
        signal,
      }),
    staleTime: QUERY_FRESHNESS.immutable,
  });
}
