import { assertSessionIdentity } from '@/features/auth/session/identity.public';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import {
  connectionSharingResponseSchema,
  connectionSharingCommandResponseSchema,
  type ConnectionSharingRequest,
} from '@pertexo/contracts';
const path = (workspaceId: string, connectionId: string) =>
  `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections/${encodeURIComponent(connectionId)}/sharing` as const;
export function readConnectionSharing(
  scope: WorkspaceApiScope,
  connectionId: string,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: path(scope.workspaceId, connectionId),
    signal,
    response: {
      kind: 'json',
      decode: (value) => connectionSharingResponseSchema.parse(value),
    },
  });
}
export async function replaceConnectionSharing(
  scope: WorkspaceApiScope,
  connectionId: string,
  body: ConnectionSharingRequest,
  key: string,
) {
  await assertSessionIdentity(scope.apiClient, scope.userId);
  return scope.apiClient.request({
    path: path(scope.workspaceId, connectionId),
    method: 'POST',
    body,
    headers: { 'idempotency-key': key },
    response: {
      kind: 'json',
      decode: (value) => connectionSharingCommandResponseSchema.parse(value),
    },
  });
}
