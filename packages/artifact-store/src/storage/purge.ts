import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';

import type { ArtifactStoreConfig } from '../config/index.js';

import { sendS3 } from '../s3/contract.js';
import { requestSignal } from '../s3/request-lifecycle.js';

import {
  assertWorkspaceVersionListing,
  validateWorkspaceVersionDeletion,
  workspaceVersionDeleteObjects,
} from '../workspace-purge-validation.js';
import type {
  S3ClientLike,
  PurgeWorkspaceObjectsRequest,
  WorkspaceObjectPurgePage,
} from './contract.js';
import { workspacePrefix } from '../identity.js';
import { purgeWorkspaceSchema } from './metadata.js';

export async function purgeWorkspaceObjects(
  {
    config,
    client,
  }: Readonly<{ config: ArtifactStoreConfig; client: S3ClientLike }>,
  request: PurgeWorkspaceObjectsRequest,
): Promise<WorkspaceObjectPurgePage> {
  const input = purgeWorkspaceSchema.parse(request);
  const prefix = workspacePrefix(input.workspaceId);
  const signal = requestSignal(config.requestTimeoutMs, request.signal);
  const listed = await sendS3(
    client,
    new ListObjectVersionsCommand({
      Bucket: config.bucket,
      MaxKeys: input.maxObjects,
      Prefix: prefix,
    }),
    { abortSignal: signal },
  );
  const entries = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])];
  assertWorkspaceVersionListing(listed, entries, input.maxObjects);
  if (entries.length === 0) {
    return Object.freeze({ completed: true, deletedCount: 0 });
  }
  const seen = new Set<string>();
  const objects = workspaceVersionDeleteObjects(entries, prefix, seen);
  const deleted = await sendS3(
    client,
    new DeleteObjectsCommand({
      Bucket: config.bucket,
      Delete: { Objects: objects, Quiet: false },
    }),
    { abortSignal: signal },
  );
  const deletedCount = validateWorkspaceVersionDeletion(
    deleted,
    seen,
    objects.length,
  );
  return Object.freeze({
    completed: false,
    deletedCount,
  });
}
