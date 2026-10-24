import { assertSessionIdentity } from '@/features/auth/session/identity.public';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import {
  folderSharingResponseSchema,
  folderSharingCommandResponseSchema,
  workflowMoveReviewResponseSchema,
  type FolderSharingRequest,
  type WorkflowMoveReviewRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
const path = (workspaceId: string) =>
  `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflow-folders` as const;
export function readFolderSharing(
  scope: WorkspaceApiScope,
  folderId: string,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${path(scope.workspaceId)}/${encodeURIComponent(folderId)}/sharing`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => folderSharingResponseSchema.parse(value),
    },
  });
}
export async function replaceFolderSharing(
  scope: WorkspaceApiScope,
  folderId: string,
  body: FolderSharingRequest,
  key: string,
) {
  await assertSessionIdentity(scope.apiClient, scope.userId);
  return scope.apiClient.request({
    path: `${path(scope.workspaceId)}/${encodeURIComponent(folderId)}/sharing`,
    method: 'POST',
    body,
    headers: { 'idempotency-key': key },
    response: {
      kind: 'json',
      decode: (value) => folderSharingCommandResponseSchema.parse(value),
    },
  });
}
export function reviewWorkflowMove(
  api: ApiClient,
  workspaceId: string,
  body: WorkflowMoveReviewRequest,
  signal?: AbortSignal,
) {
  return api.request({
    path: `${path(workspaceId)}/review-move`,
    method: 'POST',
    body,
    ...(signal ? { signal } : {}),
    response: {
      kind: 'json',
      decode: (value) => workflowMoveReviewResponseSchema.parse(value),
    },
  });
}
