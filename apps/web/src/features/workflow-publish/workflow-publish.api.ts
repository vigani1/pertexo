import {
  strongEtagSchema,
  workflowPublishResponseSchema,
  workflowValidateResponseSchema,
  type WorkflowPublishResponse,
  type WorkflowValidateResponse,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type { ApiClient } from '@/lib/api/client';

function workflowCommandPath(
  workspaceId: string,
  workflowId: string,
  command: 'publish' | 'validate',
): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/${command}`;
}

export function validateWorkflow(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
): Promise<WorkflowValidateResponse> {
  return apiClient.request({
    path: workflowCommandPath(workspaceId, workflowId, 'validate'),
    method: 'POST',
    response: {
      kind: 'json',
      decode: (value) => workflowValidateResponseSchema.parse(value),
    },
  });
}

export function publishWorkflow(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  command: Readonly<{ etag: string; idempotencyKey: string }>,
): Promise<WorkflowPublishResponse> {
  return apiClient.request({
    path: workflowCommandPath(workspaceId, workflowId, 'publish'),
    method: 'POST',
    headers: {
      'If-Match': strongEtagSchema.parse(command.etag),
      'Idempotency-Key': command.idempotencyKey,
    },
    response: {
      kind: 'json',
      decode: (value) => workflowPublishResponseSchema.parse(value),
    },
  });
}
