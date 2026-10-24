import {
  artifactMetadataResponseSchema,
  artifactUploadResponseSchema,
  type ArtifactMetadataResponse,
  type ArtifactUploadResponse,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import type { UploadMetadata } from '../model/upload';

export function beginUpload({
  apiClient,
  workspaceId,
  metadata,
  key,
  signal,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  metadata: UploadMetadata;
  key: string;
  signal: AbortSignal;
}>): Promise<ArtifactUploadResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/uploads`,
    method: 'POST',
    body: metadata,
    headers: { 'Idempotency-Key': key },
    signal,
    response: {
      kind: 'json',
      decode: (value) => artifactUploadResponseSchema.parse(value),
    },
  });
}

export function finalizeUpload(
  apiClient: ApiClient,
  workspaceId: string,
  artifactId: string,
  signal: AbortSignal,
): Promise<ArtifactMetadataResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/finalize`,
    method: 'POST',
    body: {},
    signal,
    response: {
      kind: 'json',
      decode: (value) => artifactMetadataResponseSchema.parse(value),
    },
  });
}

/** A separate capability origin receives bytes, never the application's session. */
export async function transferFile(
  file: File,
  upload: ArtifactUploadResponse['upload'],
  signal: AbortSignal,
): Promise<void> {
  const headers = new Headers(upload.headers);
  // Fetch owns this forbidden header, deriving the signed length from the Blob.
  headers.delete('content-length');
  const response = await fetch(upload.url, {
    method: 'PUT',
    headers,
    body: file,
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  await response.body?.cancel();
  if (!response.ok)
    throw new Error(
      'The storage transfer could not be confirmed. Check and retry the same file.',
    );
}
