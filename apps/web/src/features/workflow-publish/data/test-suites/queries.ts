import { queryOptions } from '@tanstack/react-query';
import type { WorkflowTestScope } from '../workflow-tests/api';
import { getSuite, getCaseReport, listSuites } from './api';
export function suitesKey(scope: WorkflowTestScope) {
  return [
    'identity',
    scope.userId,
    'workspace',
    scope.workspaceId,
    'workflow',
    scope.workflowId,
    'test-suites',
  ] as const;
}
export function suitesQueryOptions(scope: WorkflowTestScope) {
  return queryOptions({
    queryKey: [...suitesKey(scope), 'list'],
    queryFn: ({ signal }) => listSuites(scope, signal),
    staleTime: 0,
    retry: false,
  });
}
export function suiteQueryOptions(scope: WorkflowTestScope, suiteId: string) {
  return queryOptions({
    queryKey: [...suitesKey(scope), suiteId],
    queryFn: ({ signal }) => getSuite(scope, suiteId, signal),
    staleTime: 0,
    retry: false,
  });
}
export function suiteReportQueryOptions(
  scope: WorkflowTestScope,
  suiteId: string,
  ordinal: number,
) {
  return queryOptions({
    queryKey: [...suitesKey(scope), suiteId, 'case', ordinal],
    queryFn: ({ signal }) => getCaseReport(scope, suiteId, ordinal, signal),
    staleTime: Infinity,
    retry: false,
  });
}
