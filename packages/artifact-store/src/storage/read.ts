import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { GetObjectCommandOutput } from '@aws-sdk/client-s3';

import { Readable } from 'node:stream';
import { verifiedBody } from '../stream-verification.js';
import { artifactMetadataMatches } from '../metadata.js';
import { artifactStorageKey, type ArtifactIdentity } from '../identity.js';
import { ArtifactIntegrityError, ArtifactNotFoundError } from '../errors.js';
import type { ArtifactStoreConfig } from '../config/index.js';

import { sendS3 } from '../s3/contract.js';

import type {
  S3ClientLike,
  ArtifactMetadata,
  ArtifactDownload,
} from './contract.js';
import {
  isNotFound,
  metadataFromHead,
  destroyResponseBody,
} from './metadata.js';

export async function readVerifiedArtifact({
  client,
  config,
  identity,
  expected,
  signal,
}: Readonly<{
  client: S3ClientLike;
  config: ArtifactStoreConfig;
  identity: ArtifactIdentity;
  expected: ArtifactMetadata | undefined;
  signal: AbortSignal;
}>): Promise<ArtifactDownload> {
  let output: GetObjectCommandOutput;
  try {
    output = await sendS3(
      client,
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: artifactStorageKey(identity),
      }),
      {
        abortSignal: signal,
      },
    );
  } catch (error: unknown) {
    if (isNotFound(error)) {
      throw new ArtifactNotFoundError();
    }
    throw error;
  }

  if (!(output.Body instanceof Readable)) {
    destroyResponseBody(output.Body);
    throw new ArtifactIntegrityError('Stored artifact body is not streamable');
  }
  let metadata: ArtifactMetadata;
  try {
    metadata = metadataFromHead(identity, output, config.maxObjectBytes);
    if (
      expected !== undefined &&
      !artifactMetadataMatches(metadata, expected)
    ) {
      throw new ArtifactIntegrityError(
        'Stored artifact metadata does not match the expected upload',
      );
    }
  } catch (error: unknown) {
    output.Body.destroy();
    throw error;
  }
  return Object.freeze({
    body: verifiedBody(output.Body, {
      metadata: expected ?? metadata,
      maxObjectBytes: config.maxObjectBytes,
      source: 'stored',
      signal: signal,
    }),
    metadata,
  });
}
