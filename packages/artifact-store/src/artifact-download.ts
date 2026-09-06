import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import type { ArtifactStoreConfig } from './config.js';
import type { ArtifactIdentity } from './store.js';
import {
  observePresign,
  type ObjectStoreObserver,
  type ObjectStoreRegionRole,
} from './object-store-telemetry.js';

export function createArtifactDownloadPresigner(
  client: S3Client,
  observer: ObjectStoreObserver,
  regionRole: ObjectStoreRegionRole,
  override?: GetObjectPresigner,
): GetObjectPresigner {
  const presign =
    override ??
    ((request: GetObjectPresignRequest) =>
      getSignedUrl(client, request.command, {
        expiresIn: request.expiresInSeconds,
      }));
  return (request) =>
    observePresign(
      observer,
      regionRole,
      () => presign(request),
      'presign_get_object',
    );
}
import {
  awaitWithSignal,
  requestSignal,
} from './artifact-request-lifecycle.js';

export interface BeginDirectDownloadRequest extends ArtifactIdentity {
  readonly expiresInSeconds: number;
  readonly signal?: AbortSignal;
}
export interface DirectDownload {
  readonly expiresAt: string;
  readonly expiresInSeconds: number;
  readonly method: 'GET';
  readonly url: string;
}
export interface GetObjectPresignRequest {
  readonly command: GetObjectCommand;
  readonly expiresInSeconds: number;
  readonly signal: AbortSignal;
}
export type GetObjectPresigner = (
  request: GetObjectPresignRequest,
) => Promise<string>;
export interface ArtifactDownloadCapability {
  beginDirectDownload(
    request: BeginDirectDownloadRequest,
  ): Promise<DirectDownload>;
}

const downloadSchema = z.object({
  artifactId: z.uuid(),
  workspaceId: z.uuid(),
  expiresInSeconds: z.number().int().min(60).max(900),
});

/** Only canonical artifact identities can produce an attachment capability. */
export async function signArtifactDownload(
  config: ArtifactStoreConfig,
  presign: GetObjectPresigner,
  request: BeginDirectDownloadRequest,
): Promise<DirectDownload> {
  const signal = requestSignal(config.requestTimeoutMs, request.signal);
  signal.throwIfAborted();
  const input = downloadSchema.parse(request);
  const issuedAt = Date.now();
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: `workspaces/${input.workspaceId}/artifacts/${input.artifactId}`,
    ResponseContentDisposition: 'attachment',
  });
  const url = await awaitWithSignal(
    presign({ command, expiresInSeconds: input.expiresInSeconds, signal }),
    signal,
  );
  signal.throwIfAborted();
  return Object.freeze({
    expiresAt: new Date(
      issuedAt + input.expiresInSeconds * 1_000,
    ).toISOString(),
    expiresInSeconds: input.expiresInSeconds,
    method: 'GET' as const,
    url,
  });
}
