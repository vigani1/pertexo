import type { ApiClient } from '@/lib/api/client';
import { getArtifactMetadata, prepareArtifactDownload } from './artifacts.api';

type ArtifactMetadata = Awaited<ReturnType<typeof getArtifactMetadata>>;
export type PreparedDownload = Awaited<
  ReturnType<typeof prepareArtifactDownload>
>;

/**
 * A short-lived download address for a stored file. A file still being
 * written has none yet; `known` saves a read when the page already holds
 * the file's metadata.
 */
export async function prepareFileDownload(
  input: Readonly<{
    apiClient: ApiClient;
    workspaceId: string;
    artifactId: string;
    known: ArtifactMetadata | undefined;
    signal: AbortSignal;
  }>,
): Promise<
  | Readonly<{ kind: 'writing' }>
  | Readonly<{ kind: 'ready'; download: PreparedDownload }>
> {
  const { apiClient, workspaceId, artifactId, signal } = input;
  const metadata =
    input.known?.status === 'available'
      ? input.known
      : await getArtifactMetadata(apiClient, workspaceId, artifactId, signal);
  if (metadata.status !== 'available') return { kind: 'writing' };
  return {
    kind: 'ready',
    download: await prepareArtifactDownload(
      apiClient,
      workspaceId,
      artifactId,
      signal,
    ),
  };
}
