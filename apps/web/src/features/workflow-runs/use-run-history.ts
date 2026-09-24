import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { ApiClient } from '@/lib/api/client';
import type { RunHistoryFilters } from './model/run-search';
import { workflowRunsInfiniteQueryOptions } from './workflow-runs.queries';

const LIVE_REFRESH_MS = 10_000;

/**
 * The paged run list for a filter set. With `live` on it refreshes every
 * 10 s while the tab is visible — honest polling, as there is no
 * workspace-wide event stream.
 */
export function useRunHistory({
  apiClient,
  userId,
  workspace,
  filters,
  live,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  filters: RunHistoryFilters;
  live: boolean;
}>) {
  const canRead = workspace.capabilities.includes('run:read');
  const query = useInfiniteQuery({
    ...workflowRunsInfiniteQueryOptions(
      apiClient,
      userId,
      workspace.id,
      filters,
    ),
    enabled: canRead,
    refetchInterval: live ? LIVE_REFRESH_MS : false,
  });
  const runs = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  return { query, runs, canRead } as const;
}

export type RunHistoryQuery = ReturnType<typeof useRunHistory>['query'];
