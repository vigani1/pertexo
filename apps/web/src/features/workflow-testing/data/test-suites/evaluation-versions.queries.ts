import { queryOptions } from '@tanstack/react-query';
import { getAllWorkflowVersions } from '@/features/workflow-versions/workflow-versions-queries.public';
import { QUERY_FRESHNESS } from '@/lib/api/query-timings';
import type { WorkflowTestScope } from '../workflow-tests/workflow-tests.api';

export function evaluationVersionsQuery(scope: WorkflowTestScope) {
  return queryOptions({
    queryKey: [
      'identity',
      scope.userId,
      'workspace',
      scope.workspaceId,
      'workflow',
      scope.workflowId,
      'evaluation-versions',
    ],
    queryFn: ({ signal }) =>
      getAllWorkflowVersions(
        scope.apiClient,
        scope.workspaceId,
        scope.workflowId,
        signal,
      ),
    staleTime: QUERY_FRESHNESS.working,
  });
}
