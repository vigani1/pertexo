import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { findWorkflowVersion } from '@/features/workflow-versions/public';
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
  const queryKey = workflowRunKeys.detail(userId, workspaceId, runId);
  return queryOptions({
    queryKey,
    queryFn: async ({ signal, client }) => {
      try {
        return await getWorkflowRun(apiClient, workspaceId, runId, signal);
      } catch (error: unknown) {
        await forgetUnavailableRunReads(client, queryKey, queryKey, error);
        throw error;
      }
    },
    // Call acceptance is an action between parent transitions. Refresh its
    // lineage while it waits; ordinary event-driven runs need no polling.
    refetchInterval: (query) => {
      const snapshot = query.state.data;
      if (snapshot?.errorWorkflow?.status === 'pending') return 2_000;
      const needsCallUpdates =
        snapshot !== undefined &&
        isActiveRunStatus(snapshot.run.status) &&
        (snapshot.calls?.some(
          (call) => call.status === 'pending' || call.status === 'accepted',
        ) ??
          false);
      return needsCallUpdates ? 2_000 : false;
    },
    staleTime: 0,
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
    staleTime: 30_000,
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
    staleTime: 30_000,
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
    staleTime: Number.POSITIVE_INFINITY,
  });
}
