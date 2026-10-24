import type { WorkflowRunStatisticsWindow } from '@pertexo/contracts';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { RunHistoryFilters } from '../model/list/run-search';
import { isApiError } from '@/lib/api/error';

export const workflowRunKeys = {
  scope: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'runs'] as const,
  history: (userId: string, workspaceId: string, filters: RunHistoryFilters) =>
    [
      ...workflowRunKeys.scope(userId, workspaceId),
      'history',
      filters,
    ] as const,
  detail: (userId: string, workspaceId: string, runId: string) =>
    [...workflowRunKeys.scope(userId, workspaceId), 'detail', runId] as const,
  /** Stored run data, apart from the detail so live events don't refetch it. */
  data: (userId: string, workspaceId: string, runId: string) =>
    [...workflowRunKeys.scope(userId, workspaceId), 'data', runId] as const,
  statistics: (
    userId: string,
    workspaceId: string,
    window: WorkflowRunStatisticsWindow,
    breakdown: 'none' | 'workflow',
  ) =>
    [
      ...workflowRunKeys.scope(userId, workspaceId),
      'statistics',
      window,
      breakdown,
    ] as const,
  attention: (userId: string, workspaceId: string) =>
    [...workflowRunKeys.scope(userId, workspaceId), 'attention-24h'] as const,
  loom: (userId: string, workspaceId: string, windowMs: number) =>
    [...workflowRunKeys.scope(userId, workspaceId), 'loom', windowMs] as const,
  anyRun: (userId: string, workspaceId: string) =>
    [...workflowRunKeys.scope(userId, workspaceId), 'any'] as const,
  latestOf: (
    userId: string,
    workspaceId: string,
    workflowId: string,
    limit: number,
  ) =>
    [
      ...workflowRunKeys.scope(userId, workspaceId),
      'latest-of',
      workflowId,
      limit,
    ] as const,
};

/** Denials revoke snapshots durably, including inactive history filters. */
export async function forgetUnavailableRunReads(
  client: QueryClient,
  scope: QueryKey,
  currentKey: QueryKey,
  error: unknown,
): Promise<void> {
  if (!isApiError(error) || ![401, 403, 404, 409].includes(error.status ?? 0))
    return;
  const current = client
    .getQueryCache()
    .find({ queryKey: currentKey, exact: true });
  await client.cancelQueries({
    queryKey: scope,
    predicate: (query) => query !== current,
  });
  client
    .getQueryCache()
    .findAll({ queryKey: scope })
    .forEach((query) => {
      query.setState({ data: undefined, dataUpdatedAt: 0 });
    });
}
