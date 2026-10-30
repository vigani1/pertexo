import type { ApiClient } from './client';
export type WorkspaceApiScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>;

/** The key prefix every read in one user's workspace sits under. */
export function workspaceReadScope(userId: string, workspaceId: string) {
  return ['identity', userId, 'workspace', workspaceId] as const;
}
