import {
  workflowConcurrencySettingsSchema,
  workflowConcurrencySettingsRequestSchema,
  workflowConcurrencyCommandResponseSchema,
  workflowConcurrencyRevisionConflictProblemSchema,
  workflowConcurrencyLimitExceededProblemSchema,
  type WorkflowConcurrencySettingsRequest,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type { ApiClient } from '@/lib/api/client';

function path(workspaceId: string, workflowId: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/concurrency`;
}

export function getWorkflowConcurrency(
  client: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
) {
  return client.request({
    path: path(workspaceId, workflowId),
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => workflowConcurrencySettingsSchema.parse(value),
    },
  });
}

export function putWorkflowConcurrency(
  client: ApiClient,
  workspaceId: string,
  workflowId: string,
  body: WorkflowConcurrencySettingsRequest,
  key: string,
) {
  return client.request({
    path: path(workspaceId, workflowId),
    method: 'PUT',
    headers: { 'Idempotency-Key': key },
    body: workflowConcurrencySettingsRequestSchema.parse(body),
    decodeProblem: (value) =>
      workflowConcurrencyRevisionConflictProblemSchema
        .or(workflowConcurrencyLimitExceededProblemSchema)
        .parse(value),
    response: {
      kind: 'json',
      decode: (value) => workflowConcurrencyCommandResponseSchema.parse(value),
    },
  });
}
