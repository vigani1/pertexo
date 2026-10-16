import {
  workflowTestCancelResponseSchema,
  workflowTestPreparationSchema,
  workflowTestAcceptedSchema,
  workflowTestDetailSchema,
  workflowTestListSchema,
  type WorkflowTestStartRequest,
} from '@pertexo/contracts';
import type { SampleScope } from '../samples/api';
export type WorkflowTestScope = SampleScope;
function path(scope: WorkflowTestScope): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/workflows/${encodeURIComponent(scope.workflowId)}/draft/tests`;
}
export function prepareWorkflowTest(
  scope: WorkflowTestScope,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${path(scope)}/prepare`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowTestPreparationSchema.parse(value),
    },
  });
}
export function startWorkflowTest(
  scope: WorkflowTestScope,
  body: WorkflowTestStartRequest,
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
      decode: (value) => workflowTestAcceptedSchema.parse(value),
    },
  });
}
export function listWorkflowTests(
  scope: WorkflowTestScope,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: path(scope),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowTestListSchema.parse(value),
    },
  });
}
export function getWorkflowTest(
  scope: WorkflowTestScope,
  runId: string,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${path(scope)}/${encodeURIComponent(runId)}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowTestDetailSchema.parse(value),
    },
  });
}
export async function cancelWorkflowTest(
  scope: WorkflowTestScope,
  runId: string,
  signal: AbortSignal,
) {
  await scope.apiClient.request({
    path: `${path(scope)}/${encodeURIComponent(runId)}/cancel`,
    method: 'POST',
    body: {},
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowTestCancelResponseSchema.parse(value),
    },
  });
}
