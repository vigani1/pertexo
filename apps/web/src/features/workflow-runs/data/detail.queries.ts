import { QUERY_FRESHNESS, QUERY_POLLING } from '@/lib/api/query-timings';
import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { findWorkflowVersion } from '@/features/workflow-versions/workflow-versions-queries.public';
import { isActiveRunStatus } from '../model/presentation/run-status';
import {
  getWorkflowRun,
  getWorkflowStepHealth,
  getWorkflowStepRuns,
} from './workflow-runs.api';
import { workflowRunKeys, forgetUnavailableRunReads } from './query-cache';

export function workflowRunQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  runId: string,
) {
  const runKey = workflowRunKeys.detail(userId, workspaceId, runId);
  return runSnapshotQueryOptions(apiClient, workspaceId, runId, { runKey });
}

export function canvasRunQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  runId: string,
) {
  const runKey = workflowRunKeys.detail(userId, workspaceId, runId);
  // Leaving the canvas cancels its in-flight read when its observer unmounts.
  // The route loader needs its own request to survive that transition.
  return runSnapshotQueryOptions(apiClient, workspaceId, runId, {
    runKey,
    surface: 'canvas',
  });
}

type RunKey = ReturnType<typeof workflowRunKeys.detail>;

function runSnapshotQueryOptions(
  apiClient: ApiClient,
  workspaceId: string,
  runId: string,
  { runKey, surface }: Readonly<{ runKey: RunKey; surface?: 'canvas' }>,
) {
  const queryKey =
    surface === undefined ? runKey : ([...runKey, surface] as const);
  return queryOptions({
    queryKey,
    queryFn: async ({ signal, client }) => {
      try {
        return await getWorkflowRun(apiClient, workspaceId, runId, signal);
      } catch (error: unknown) {
        await forgetUnavailableRunReads(client, runKey, queryKey, error);
        throw error;
      }
    },
    // Call acceptance is an action between parent transitions. Refresh its
    // lineage while it waits; ordinary event-driven runs need no polling.
    refetchInterval: (query) => {
      const snapshot = query.state.data;
      if (snapshot?.errorWorkflow?.status === 'pending')
        return QUERY_POLLING.waiting;
      const needsCallUpdates =
        snapshot !== undefined &&
        isActiveRunStatus(snapshot.run.status) &&
        (snapshot.calls?.some(
          (call) => call.status === 'pending' || call.status === 'accepted',
        ) ??
          false);
      return needsCallUpdates ? QUERY_POLLING.waiting : false;
    },
    staleTime: QUERY_FRESHNESS.none,
  });
}

/** Each step across the workflow's last 100 runs (ADR 051). */
export function stepHealthQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  return queryOptions({
    queryKey: [
      ...workflowRunKeys.scope(userId, workspaceId),
      'step-health',
      workflowId,
    ],
    queryFn: ({ signal }) =>
      getWorkflowStepHealth(apiClient, workspaceId, workflowId, signal),
    staleTime: QUERY_FRESHNESS.standard,
  });
}

/** One step's latest runs in its workflow, newest first. */
export function stepRunsQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  step: Readonly<{ workflowId: string; nodeId: string; limit: number }>,
) {
  return queryOptions({
    queryKey: [
      ...workflowRunKeys.scope(userId, workspaceId),
      'step-runs',
      step.workflowId,
      step.nodeId,
      step.limit,
    ],
    queryFn: ({ signal }) =>
      getWorkflowStepRuns({
        apiClient,
        workspaceId,
        workflowId: step.workflowId,
        nodeId: step.nodeId,
        limit: step.limit,
        signal,
      }),
    staleTime: QUERY_FRESHNESS.standard,
  });
}

export function workflowRunVersionQueryOptions({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  versionId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  versionId: string;
}>) {
  return queryOptions({
    queryKey: [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'workflow',
      workflowId,
      'version',
      versionId,
    ] as const,
    queryFn: ({ signal }) =>
      findWorkflowVersion({
        apiClient,
        workspaceId,
        workflowId,
        versionId,
        signal,
      }),
    staleTime: QUERY_FRESHNESS.immutable,
  });
}
