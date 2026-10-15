import type { ApiClient } from './client';
export type WorkspaceApiScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>;
