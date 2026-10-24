import {
  workflowErrorSettingsSchema,
  workflowErrorSettingsRequestSchema,
  workflowErrorSettingsResponseSchema,
  workflowErrorTargetsPageSchema,
  type WorkflowErrorSettingsRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';

const path = (workspaceId: string, workflowId: string): `/v1${string}` =>
  `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/error-workflow`;
export function getErrorWorkflow(
  client: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal: AbortSignal,
) {
  return client.request({
    path: path(workspaceId, workflowId),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowErrorSettingsSchema.parse(value),
    },
  });
}
export function getErrorTargets({
  client,
  workspaceId,
  workflowId,
  after,
  signal,
}: Readonly<{
  client: ApiClient;
  workspaceId: string;
  workflowId: string;
  after: string | undefined;
  signal: AbortSignal;
}>) {
  const cursor =
    after === undefined ? '' : `?after=${encodeURIComponent(after)}`;
  return client.request({
    path: `${path(workspaceId, workflowId)}/targets${cursor}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowErrorTargetsPageSchema.parse(value),
    },
  });
}
export function putErrorWorkflow({
  client,
  workspaceId,
  workflowId,
  body,
  key,
}: Readonly<{
  client: ApiClient;
  workspaceId: string;
  workflowId: string;
  body: WorkflowErrorSettingsRequest;
  key: string;
}>) {
  return client.request({
    path: path(workspaceId, workflowId),
    method: 'PUT',
    headers: { 'Idempotency-Key': key },
    body: workflowErrorSettingsRequestSchema.parse(body),
    response: {
      kind: 'json',
      decode: (value) => workflowErrorSettingsResponseSchema.parse(value),
    },
  });
}
