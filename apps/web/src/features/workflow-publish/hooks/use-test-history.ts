import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { workflowRunQueryOptions } from '@/features/workflow-runs/queries.public';
import { isActiveRunStatus } from '@/features/workflow-runs/labels.public';
import type { WorkflowTestScope } from '../data/workflow-tests/api';
import {
  workflowTestsQueryOptions,
  workflowTestQueryOptions,
} from '../data/workflow-tests/queries';

export function useTestHistory({
  scope,
  enabled,
}: Readonly<{ scope: WorkflowTestScope; enabled: boolean }>) {
  const [selectedRunId, selectRun] = useState<string>();
  const history = useQuery({
    ...workflowTestsQueryOptions(scope),
    enabled,
    refetchInterval: (query) =>
      (query.state.data?.items.some((item) => isActiveRunStatus(item.status)) ??
      false)
        ? 2000
        : false,
  });
  const activeId = selectedRunId ?? history.data?.items[0]?.runId;
  const snapshot = useQuery({
    ...workflowTestQueryOptions(scope, activeId ?? ''),
    enabled: enabled && activeId !== undefined,
  });
  const progress = useQuery({
    ...workflowRunQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
      activeId ?? '',
    ),
    enabled: enabled && activeId !== undefined,
  });
  const blocked =
    history.data?.items.some(
      (item) =>
        item.startedBy === scope.userId &&
        isActiveRunStatus(
          item.runId === progress.data?.run.id
            ? progress.data.run.status
            : item.status,
        ),
    ) ?? false;
  return { history, snapshot, progress, activeId, selectRun, blocked };
}
