import {
  workspaceDeletionRequestSchema,
  workspaceLifecycleChangeResponseSchema,
  type WorkspaceLifecycleChangeResponse,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';

export function requestWorkspaceDeletion(
  apiClient: ApiClient,
  workspaceId: string,
  input: Readonly<{ reason: string; idempotencyKey: string }>,
): Promise<WorkspaceLifecycleChangeResponse> {
  const body = workspaceDeletionRequestSchema.parse({ reason: input.reason });
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/deletion`,
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': input.idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => decodeLifecycleChange(value, workspaceId),
    },
  });
}

export function restoreWorkspaceDeletion(
  apiClient: ApiClient,
  workspaceId: string,
  idempotencyKey: string,
): Promise<WorkspaceLifecycleChangeResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/deletion`,
    method: 'DELETE',
    headers: { 'Idempotency-Key': idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => decodeLifecycleChange(value, workspaceId),
    },
  });
}

export function reactivateWorkspace(
  apiClient: ApiClient,
  workspaceId: string,
  idempotencyKey: string,
): Promise<WorkspaceLifecycleChangeResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/reactivate`,
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    response: {
      kind: 'json',
      decode: (value) => decodeLifecycleChange(value, workspaceId),
    },
  });
}

function decodeLifecycleChange(value: unknown, workspaceId: string) {
  const change = workspaceLifecycleChangeResponseSchema.parse(value);
  if (change.workspaceId !== workspaceId)
    throw new Error('Lifecycle change workspace mismatch.');
  return change;
}
