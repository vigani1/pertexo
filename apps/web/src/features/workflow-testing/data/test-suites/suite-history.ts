import { QUERY_POLLING } from '@/lib/api/query-timings';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkflowTestScope } from '../workflow-tests/workflow-tests.api';
import { workflowTestsKey } from '../workflow-tests/workflow-tests.queries';
import {
  suitesQueryOptions,
  suiteQueryOptions,
} from './workflow-test-suites.queries';

export function useSuiteHistory({
  scope,
  enabled,
}: Readonly<{ scope: WorkflowTestScope; enabled: boolean }>) {
  const cache = useQueryClient();
  const [selectedId, select] = useState<string>();
  const history = useQuery({
    ...suitesQueryOptions(scope),
    enabled,
    refetchInterval: (query) =>
      (query.state.data?.items.some((item) => item.status === 'running') ??
      false)
        ? QUERY_POLLING.waiting
        : false,
  });
  const activeId = selectedId ?? history.data?.items[0]?.suiteId;
  const detail = useQuery({
    ...suiteQueryOptions(scope, activeId ?? ''),
    enabled: enabled && activeId !== undefined,
    refetchInterval: (query) =>
      query.state.data?.status === 'running' ? QUERY_POLLING.inFlight : false,
  });
  const latestRunId = detail.data?.cases.reduce<string | null>(
    (last, entry) => entry.runId ?? last,
    null,
  );
  useEffect(() => {
    if (latestRunId !== undefined && latestRunId !== null)
      void cache.invalidateQueries({
        queryKey: [
          ...workflowTestsKey({
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            workflowId: scope.workflowId,
          }),
          'list',
        ],
        exact: true,
      });
  }, [cache, latestRunId, scope.userId, scope.workspaceId, scope.workflowId]);
  const blocked =
    history.data?.items.some(
      (item) =>
        item.startedBy === scope.userId &&
        (item.suiteId === detail.data?.suiteId
          ? detail.data.status
          : item.status) === 'running',
    ) ?? false;
  return { history, detail, activeId, select, blocked };
}
