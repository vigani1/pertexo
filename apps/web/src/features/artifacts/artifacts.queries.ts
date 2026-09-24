import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { getArtifactMetadata } from './artifacts.api';

export const artifactKeys = {
  metadata: (userId: string, workspaceId: string, artifactId: string) =>
    [
      'identity',
      userId,
      'workspace',
      workspaceId,
      'artifacts',
      artifactId,
    ] as const,
};

/** A file output's type, size and readiness (never its content). */
export function artifactMetadataQueryOptions(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  artifactId: string,
) {
  return queryOptions({
    queryKey: artifactKeys.metadata(userId, workspaceId, artifactId),
    queryFn: ({ signal }) =>
      getArtifactMetadata(apiClient, workspaceId, artifactId, signal),
    staleTime: 60_000,
  });
}
