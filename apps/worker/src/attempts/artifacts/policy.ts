import { z } from 'zod';
import {
  nodeArtifactReferenceSchema,
  FILE_PAGE_LIMITS,
} from '@pertexo/node-sdk';
import {
  ArtifactByteLimitError,
  ArtifactRetentionExpiredError,
} from './artifact-policy.errors.js';

/** The longest purpose label an artifact may carry. */
const ARTIFACT_PURPOSE_MAX_CHARACTERS = 64;

export function assertArtifactByteLimit(maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > FILE_PAGE_LIMITS.fileBytes
  )
    throw new ArtifactByteLimitError('Node artifact byte limit is invalid');
}

export function artifactExpiry(
  createdAt: Date,
  retentionMillis: number,
  retentionDeadline: Date | undefined,
): Date {
  const defaultExpiry = new Date(createdAt.getTime() + retentionMillis);
  const expiresAt =
    retentionDeadline !== undefined &&
    retentionDeadline.getTime() < defaultExpiry.getTime()
      ? retentionDeadline
      : defaultExpiry;
  if (expiresAt.getTime() <= createdAt.getTime())
    throw new ArtifactRetentionExpiredError(
      'Artifact retention deadline has expired',
    );
  return expiresAt;
}

export const artifactWriteMetadataSchema = z.object({
  mediaType: z
    .string()
    .trim()
    .pipe(nodeArtifactReferenceSchema.unwrap().shape.mediaType),
  purpose: z
    .string()
    .min(1)
    .max(ARTIFACT_PURPOSE_MAX_CHARACTERS)
    .regex(/^[a-z][a-z0-9-]*$/u),
});
