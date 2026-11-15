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

/** The wait before the next read of a recording, after `reads` reads. */
function inputRecordingWait(reads: number): number {
  return INPUT_RECORDING_FIRST_WAIT_MS * INPUT_RECORDING_BACKOFF ** (reads - 1);
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
    refetchInterval: (query) => {
      // A failed refetch retains the last empty response. Stop here so the
      // visible retry action, not a successful-read counter, owns recovery.
      if (query.state.status === 'error') return false;
      const reads = query.state.dataUpdateCount;
      return step.status === 'running' &&
        query.state.data?.kind === 'none' &&
        reads < INPUT_RECORDING_READS
        ? inputRecordingWait(reads)
        : false;
    },
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
        signal,
      }),
    staleTime: QUERY_FRESHNESS.immutable,
  });
}
