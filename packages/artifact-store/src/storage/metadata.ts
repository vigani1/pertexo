import type {
  GetObjectCommandOutput,
  HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';

import type { Readable } from 'node:stream';

import { z } from 'zod';

import { artifactIdentitySchema, type ArtifactIdentity } from '../identity.js';
import { ArtifactIntegrityError } from '../errors.js';

import type { ArtifactMetadata, Destroyable } from './contract.js';

export const purgeWorkspaceSchema = z.object({
  maxObjects: z.number().int().min(1).max(500),
  workspaceId: z.uuid(),
});

export const metadataSchema = artifactIdentitySchema.extend({
  byteLength: z.number().int().nonnegative(),
  mediaType: z
    .string()
    .trim()
    .min(3)
    .max(255)
    .regex(/^[^\s/;]+\/[^\r\n]+$/u)
    .regex(/^[\t\x20-\x7e\x80-\xff]+$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const beginDirectUploadSchema = metadataSchema.extend({
  expiresInSeconds: z.number().int().min(60).max(900),
});

const STORAGE_METADATA = {
  artifactId: 'artifact-id',
  byteLength: 'byte-length',
  mediaType: 'media-type',
  sha256: 'sha256',
  workspaceId: 'workspace-id',
} as const;

const USER_METADATA_KEYS = Object.values(STORAGE_METADATA).toSorted();

export const DIRECT_UPLOAD_SIGNABLE_HEADERS = new Set([
  'content-length',
  'content-type',
  'if-none-match',
]);

export const DIRECT_UPLOAD_UNHOISTABLE_HEADERS = new Set([
  'x-amz-checksum-sha256',
  ...USER_METADATA_KEYS.map((key) => `x-amz-meta-${key}`),
]);

export function isNotFound(error: unknown): boolean {
  try {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const candidate = error as {
      readonly $metadata?: { readonly httpStatusCode?: number };
      readonly name?: string;
    };
    return (
      candidate.$metadata?.httpStatusCode === 404 ||
      candidate.name === 'NoSuchKey' ||
      candidate.name === 'NotFound'
    );
  } catch {
    return false;
  }
}

export function objectMetadata(
  metadata: ArtifactMetadata,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [STORAGE_METADATA.artifactId]: metadata.artifactId,
    [STORAGE_METADATA.byteLength]: String(metadata.byteLength),
    [STORAGE_METADATA.mediaType]: metadata.mediaType,
    [STORAGE_METADATA.sha256]: metadata.sha256,
    [STORAGE_METADATA.workspaceId]: metadata.workspaceId,
  });
}

export function checksumSha256Base64(sha256: string): string {
  return Buffer.from(sha256, 'hex').toString('base64');
}

export function metadataFromHead(
  identity: ArtifactIdentity,
  output: HeadObjectCommandOutput | GetObjectCommandOutput,
  maxObjectBytes: number,
): ArtifactMetadata {
  const metadata = output.Metadata ?? {};
  const metadataKeys = Object.keys(metadata).toSorted();
  const parsedByteLength = Number(metadata[STORAGE_METADATA.byteLength]);
  const storedContentType = output.ContentType?.replace(/\s*;\s*/gu, ';');
  const candidate = metadataSchema.safeParse({
    artifactId: metadata[STORAGE_METADATA.artifactId],
    byteLength: parsedByteLength,
    mediaType: metadata[STORAGE_METADATA.mediaType],
    sha256: metadata[STORAGE_METADATA.sha256],
    workspaceId: metadata[STORAGE_METADATA.workspaceId],
  });

  const invalidStoredMetadata =
    !candidate.success ||
    metadataKeys.length !== USER_METADATA_KEYS.length ||
    metadataKeys.some((key, index) => key !== USER_METADATA_KEYS[index]) ||
    candidate.data.artifactId !== identity.artifactId ||
    candidate.data.workspaceId !== identity.workspaceId ||
    candidate.data.byteLength > maxObjectBytes ||
    output.ContentLength !== candidate.data.byteLength ||
    storedContentType !== candidate.data.mediaType.replace(/\s*;\s*/gu, ';');
  if (invalidStoredMetadata) {
    throw new ArtifactIntegrityError('Stored artifact metadata is invalid');
  }

  return Object.freeze(candidate.data);
}

export async function consume(body: Readable): Promise<void> {
  for await (const _chunk of body) {
    // Integrity is enforced by the verifier while bytes are discarded.
  }
}

export function destroyResponseBody(body: unknown): void {
  if (isDestroyable(body)) {
    body.destroy();
  }
}

function isDestroyable(value: unknown): value is Destroyable {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { readonly destroy?: unknown };
  return typeof candidate.destroy === 'function';
}
