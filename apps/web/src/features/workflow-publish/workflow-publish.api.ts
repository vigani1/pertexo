import {
  strongEtagSchema,
  workflowPublishResponseSchema,
  workflowValidateResponseSchema,
  workflowVersionsResponseSchema,
  type WorkflowPublishResponse,
  type WorkflowValidateResponse,
  type WorkflowVersionResponse,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type { ApiClient } from '@/lib/api/client';

function workflowPath(workspaceId: string, workflowId: string) {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}` as const;
}

export function validateWorkflow(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
): Promise<WorkflowValidateResponse> {
  return apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/validate`,
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
    path: `${workflowPath(workspaceId, workflowId)}/publish`,
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

/** The highest-numbered version: the list is ordered newest first. */
export async function getLatestWorkflowVersion(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowVersionResponse | null> {
  const response = await apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/versions?limit=1`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => workflowVersionsResponseSchema.parse(value),
    },
  });
  return response.items[0] ?? null;
}
