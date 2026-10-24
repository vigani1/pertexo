import { z } from 'zod';
import type { ArtifactMetadataIdentity } from './contract.js';

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024 * 1024;

const HTTP_FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/u;

export const artifactByteLengthSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_ARTIFACT_BYTES);

export const artifactMediaTypeSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(/^[^\s/;]+\/[^\r\n]+$/u)
  .regex(HTTP_FIELD_VALUE);

export const artifactSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export function artifactMetadataMatches(
  actual: ArtifactMetadataIdentity,
  expected: ArtifactMetadataIdentity,
): boolean {
  return (
    actual.byteLength === expected.byteLength &&
    actual.mediaType === expected.mediaType &&
    actual.sha256 === expected.sha256
  );
}
