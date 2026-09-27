import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import {
  getWorkflowNodeRunInput,
  getWorkflowNodeRunOutput,
  getWorkflowRunInput,
} from './workflow-runs.api';
import { workflowRunKeys } from './workflow-runs.queries';

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
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * A step run's output. It only changes when the step does, so the step's
 * status is part of the key: a step that finishes is read again.
 */
export function nodeRunOutputQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  runId: string,
  step: Readonly<{ nodeRunId: string; status: string }>,
) {
  return queryOptions({
    queryKey: [
      ...workflowRunKeys.data(userId, workspaceId, runId),
      'output',
      step.nodeRunId,
      step.status,
    ],
    queryFn: ({ signal }) =>
      getWorkflowNodeRunOutput(
        apiClient,
        workspaceId,
        runId,
        step.nodeRunId,
        signal,
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Reads, the first included, while a running attempt hasn't recorded yet. */
const INPUT_RECORDING_READS = 5;

/**
 * What a step run's current attempt received (ADR 052). A recording belongs
 * to one attempt, so each attempt, and each status it reaches, reads again;
 * a settled read stays cached. The worker records the input just after the
 * attempt starts, so while it runs with nothing recorded, the read repeats a
 * few times at a widening interval, then waits for the next status.
 */
export function nodeRunInputQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  runId: string,
  step: Readonly<{
    nodeRunId: string;
    attemptNumber: number | undefined;
    status: string;
  }>,
) {
  return queryOptions({
    queryKey: [
      ...workflowRunKeys.data(userId, workspaceId, runId),
      'input-of',
      step.nodeRunId,
      step.attemptNumber ?? null,
      step.status,
    ],
    queryFn: ({ signal }) =>
      getWorkflowNodeRunInput(
        apiClient,
        workspaceId,
        runId,
        step.nodeRunId,
        signal,
      ),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: (query) => {
      const reads = query.state.dataUpdateCount;
      return step.status === 'running' &&
        query.state.data?.kind === 'none' &&
        reads < INPUT_RECORDING_READS
        ? 1_000 * 2 ** (reads - 1)
        : false;
    },
  });
}
