import { useEffect } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@/lib/api/error';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { variableUsageQueryOptions } from '../data/variables.queries';

/**
 * Walks a name's references to the end, because "not used" means nothing before
 * then. Closing the dialog cancels the walk: its query loses its only observer.
 * A failed page stops it, so a refusal is never asked again by itself.
 */
export function useVariableUsageCheck(scope: WorkspaceApiScope, name: string) {
  const queryClient = useQueryClient();
  const options = variableUsageQueryOptions(scope, name);
  const query = useInfiniteQuery(options);
  const {
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError)
      void fetchNextPage({ cancelRefetch: false });
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  /** A changed workflow refuses its cursor for good, so only a new check helps. */
  const workflowChanged =
    isApiError(query.error) &&
    query.error.problem?.code === 'variables.usage_changed';
  return {
    query,
    phase: checkPhase(query),
    workflowChanged,
    resume: () => {
      if (workflowChanged)
        void queryClient.resetQueries({
          queryKey: options.queryKey,
          exact: true,
        });
      else void fetchNextPage();
    },
  };
}

export type UsageCheckPhase = 'checking' | 'failed' | 'finished';

function checkPhase(
  query: Readonly<{
    isFetching: boolean;
    isError: boolean;
    hasNextPage: boolean;
  }>,
): UsageCheckPhase {
  if (query.isFetching) return 'checking';
  if (query.isError) return 'failed';
  return query.hasNextPage ? 'checking' : 'finished';
}
