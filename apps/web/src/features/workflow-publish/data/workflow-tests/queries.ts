import { queryOptions } from '@tanstack/react-query';
import {
  getWorkflowTest,
  listWorkflowTests,
  type WorkflowTestScope,
} from './api';
export function workflowTestsKey(
  scope: Pick<WorkflowTestScope, 'userId' | 'workspaceId' | 'workflowId'>,
) {
  return [
    'identity',
    scope.userId,
    'workspace',
    scope.workspaceId,
    'workflow',
    scope.workflowId,
    'draft-tests',
  ] as const;
}
export function workflowTestsQueryOptions(scope: WorkflowTestScope) {
  return queryOptions({
    queryKey: [...workflowTestsKey(scope), 'list'],
    queryFn: ({ signal }) => listWorkflowTests(scope, signal),
    staleTime: 0,
    retry: false,
  });
}
export function workflowTestQueryOptions(
  scope: WorkflowTestScope,
  runId: string,
) {
  return queryOptions({
    queryKey: [...workflowTestsKey(scope), runId],
    queryFn: ({ signal }) => getWorkflowTest(scope, runId, signal),
    staleTime: Infinity,
    retry: false,
  });
}
