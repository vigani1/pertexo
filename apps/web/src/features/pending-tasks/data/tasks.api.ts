import {
  pendingTaskListResponseSchema,
  pendingTaskResponseSchema,
  pendingTaskDecisionResponseSchema,
  approvalAudiencePageSchema,
  type PendingTaskListQuery,
  type PendingTaskDecisionRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { searchParams } from '@/lib/api/pagination';
export type TaskScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>;
const path = (workspaceId: string): `/v1${string}` =>
  `/v1/workspaces/${encodeURIComponent(workspaceId)}/pending-tasks`;
export function listTasks(
  scope: TaskScope,
  input: PendingTaskListQuery,
  signal?: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${path(scope.workspaceId)}?${searchParams(input)}`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => pendingTaskListResponseSchema.parse(value),
    },
  });
}
export function getTask(
  scope: TaskScope,
  taskId: string,
  signal?: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${path(scope.workspaceId)}/${encodeURIComponent(taskId)}`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => pendingTaskResponseSchema.parse(value),
    },
  });
}
export function decideTask(
  scope: TaskScope,
  taskId: string,
  body: PendingTaskDecisionRequest,
  key: string,
) {
  return scope.apiClient.request({
    path: `${path(scope.workspaceId)}/${encodeURIComponent(taskId)}/decide`,
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body,
    response: {
      kind: 'json',
      decode: (value) => pendingTaskDecisionResponseSchema.parse(value),
    },
  });
}
export function listAudience(
  scope: TaskScope,
  q: string,
  after: string | null,
  signal?: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${path(scope.workspaceId)}/audience?${searchParams({ q, ...(after === null ? {} : { after }) })}`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => approvalAudiencePageSchema.parse(value),
    },
  });
}

export function submitTask(
  scope: TaskScope,
  taskId: string,
  values: Readonly<Record<string, string | number | boolean>>,
  key: string,
) {
  return scope.apiClient.request({
    path: `${path(scope.workspaceId)}/${encodeURIComponent(taskId)}/submit`,
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: { values },
    response: {
      kind: 'json',
      decode: (value) => pendingTaskDecisionResponseSchema.parse(value),
    },
  });
}
