import {
  artifactDownloadResponseSchema,
  artifactMetadataResponseSchema,
  type ArtifactDownloadResponse,
  type ArtifactMetadataResponse,
} from '@pertexo/contracts/schemas/artifacts';
import type { ApiClient } from '@/lib/api/client';

function artifactPath(workspaceId: string, artifactId: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

export function getArtifactMetadata(
  apiClient: ApiClient,
  workspaceId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<ArtifactMetadataResponse> {
  return apiClient.request({
    path: artifactPath(workspaceId, artifactId),
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => artifactMetadataResponseSchema.parse(value),
    },
  });
}

export function prepareArtifactDownload(
  apiClient: ApiClient,
  workspaceId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<ArtifactDownloadResponse> {
  return apiClient.request({
    path: `${artifactPath(workspaceId, artifactId)}/download`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => artifactDownloadResponseSchema.parse(value),
    },
  });
}
