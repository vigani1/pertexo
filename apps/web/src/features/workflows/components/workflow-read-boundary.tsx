import { useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { isAccessLost } from '@/lib/api/error-copy';
import {
  workflowKeys,
  workflowSummaryQueryOptions,
} from '../data/workflows.queries';
/** Only this workflow's own read proves revocation; a missing command target does not. */
export function WorkflowReadBoundary({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  children,
  fallback,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  children: ReactNode;
  fallback: ReactNode;
}>) {
  const cache = useQueryClient();
  const own = useQuery(
    workflowSummaryQueryOptions(apiClient, userId, workspaceId, workflowId),
  );
  const denied = own.isError && isAccessLost(own.error);
  useEffect(
    () =>
      cache.getMutationCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'error') return;
        const cause: unknown = event.mutation.state.error;
        if (isApiError(cause) && [403, 404].includes(cause.status ?? 0)) {
          void cache.invalidateQueries({
            queryKey: workflowKeys.detail(userId, workspaceId, workflowId),
            exact: true,
          });
        }
      }),
    [cache, userId, workspaceId, workflowId],
  );
  useEffect(() => {
    if (!denied) return;
    const ownQuery = cache.getQueryCache().find({
      queryKey: workflowKeys.detail(userId, workspaceId, workflowId),
      exact: true,
    });
    const predicate = (query: { queryKey: readonly unknown[] }) => {
      const key = query.queryKey;
      const isWorkflowPrivateRead =
        key[0] === 'identity' &&
        key[1] === userId &&
        key[2] === 'workspace' &&
        key[3] === workspaceId &&
        (key.slice(4).includes(workflowId) ||
          [
            'workflows',
            'workflow-organization',
            'runs',
            'inbox',
            'pending-tasks',
            'trends',
          ].includes(String(key[4])));
      return isWorkflowPrivateRead;
    };
    // Preserve the rejecting read's error while canceled siblings lose their snapshots.
    void cache
      .cancelQueries({
        predicate: (query) => predicate(query) && query !== ownQuery,
      })
      .then(() => {
        for (const query of cache.getQueryCache().findAll({ predicate }))
          query.setState({ data: undefined, dataUpdatedAt: 0 });
        void cache.invalidateQueries({
          predicate: (query) => predicate(query) && query !== ownQuery,
        });
      });
  }, [cache, denied, userId, workspaceId, workflowId]);
  return denied ? fallback : children;
}
