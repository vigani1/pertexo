import { mutationOptions } from '@tanstack/react-query';
import type { WorkspaceCreateRequest } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkspaceRenameRequest } from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';
import { createWorkspace } from './workspaces.api';
import { renameWorkspace } from './workspaces.api';

export type WorkspaceCreationAttempt = Readonly<{
  body: WorkspaceCreateRequest;
  idempotencyKey: string;
}>;

export function workspaceCreationMutationOptions(apiClient: ApiClient) {
  return mutationOptions({
    mutationFn: (attempt: WorkspaceCreationAttempt) =>
      createWorkspace(apiClient, attempt),
  });
}

export type WorkspaceRenameAttempt = Readonly<{
  body: WorkspaceRenameRequest;
  idempotencyKey: string;
}>;

export function workspaceRenameMutationOptions(
  apiClient: ApiClient,
  workspaceId: string,
) {
  return mutationOptions({
    mutationFn: (attempt: WorkspaceRenameAttempt) =>
      renameWorkspace(apiClient, workspaceId, attempt),
  });
}
