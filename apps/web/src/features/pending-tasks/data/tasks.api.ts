import type { FormValues } from '@pertexo/workflow-model';
import {
  pendingTaskListResponseSchema,
  pendingTaskResponseSchema,
  pendingTaskDecisionResponseSchema,
  approvalAudiencePageSchema,
  approvalAudienceInspectionResponseSchema,
  type ApprovalAudienceInspectionRequest,
  type PendingTaskListQuery,
  type PendingTaskDecisionRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { searchParams } from '@/lib/api/pagination';
import {
  uploadTarget,
  UPLOAD_SESSION_HEADER,
  type FormUploadTarget,
} from '@/features/forms/fields.public';
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

/** The upload session names the files this response may use. */
export function submitTask(
  scope: TaskScope,
  taskId: string,
  {
    values,
    key,
    session,
  }: Readonly<{
    values: FormValues;
    key: string;
    session?: string | undefined;
  }>,
) {
  return scope.apiClient.request({
    path: `${path(scope.workspaceId)}/${encodeURIComponent(taskId)}/submit`,
    method: 'POST',
    headers: {
      'Idempotency-Key': key,
      ...(session === undefined ? {} : { [UPLOAD_SESSION_HEADER]: session }),
    },
    body: { values },
    response: {
      kind: 'json',
      decode: (value) => pendingTaskDecisionResponseSchema.parse(value),
    },
  });
}

export function inspectAudience(
  scope: TaskScope,
  audience: ApprovalAudienceInspectionRequest['audience'],
  signal?: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${path(scope.workspaceId)}/audience/inspect`,
    method: 'POST',
    body: { audience },
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => approvalAudienceInspectionResponseSchema.parse(value),
    },
  });
}

/** The task page is where an input request's files are attached. */
export function taskUploadTarget(
  scope: TaskScope,
  taskId: string,
  session: string,
): FormUploadTarget {
  return uploadTarget({
    apiClient: scope.apiClient,
    path: `${path(scope.workspaceId)}/${encodeURIComponent(taskId)}`,
    session,
  });
}
