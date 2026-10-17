import {
  workflowTestSuitePreparationSchema,
  workflowTestSuiteAcceptedSchema,
  workflowTestSuiteListSchema,
  workflowTestSuiteDetailSchema,
  workflowTestSuiteCaseReportSchema,
  workflowTestCancelResponseSchema,
  type WorkflowTestSuiteStartRequest,
} from '@pertexo/contracts';
import type { WorkflowTestScope } from '../workflow-tests/api';
function path(scope: WorkflowTestScope): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/workflows/${encodeURIComponent(scope.workflowId)}/draft/test-suites`;
}
export function prepareSuite(scope: WorkflowTestScope, signal: AbortSignal) {
  return scope.apiClient.request({
    path: `${path(scope)}/prepare`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowTestSuitePreparationSchema.parse(value),
    },
  });
}
export function startSuite(
  scope: WorkflowTestScope,
  body: WorkflowTestSuiteStartRequest,
  key: string,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: path(scope),
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': key },
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowTestSuiteAcceptedSchema.parse(value),
    },
  });
}
export function listSuites(scope: WorkflowTestScope, signal: AbortSignal) {
  return scope.apiClient.request({
    path: path(scope),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowTestSuiteListSchema.parse(value),
    },
  });
}
export function getSuite(
  scope: WorkflowTestScope,
  suiteId: string,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${path(scope)}/${encodeURIComponent(suiteId)}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowTestSuiteDetailSchema.parse(value),
    },
  });
}
export function getCaseReport(
  scope: WorkflowTestScope,
  suiteId: string,
  ordinal: number,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${path(scope)}/${encodeURIComponent(suiteId)}/cases/${String(ordinal)}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowTestSuiteCaseReportSchema.parse(value),
    },
  });
}
export function cancelSuite(
  scope: WorkflowTestScope,
  suiteId: string,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${path(scope)}/${encodeURIComponent(suiteId)}/cancel`,
    method: 'POST',
    body: {},
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowTestCancelResponseSchema.parse(value),
    },
  });
}
