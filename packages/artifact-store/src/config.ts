import { z } from 'zod';

import {
  objectStoreBucketSchema,
  objectStoreEndpointSchema,
  objectStoreForcePathStyleSchema,
  objectStoreRequestTimeoutSchema,
} from './config-primitives.js';

const DEFAULT_MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const MAX_CONFIGURABLE_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;

const artifactStoreEnvironmentSchema = z.object({
  ARTIFACT_STORE_ACCESS_KEY_ID: z.string().trim().min(1),
  ARTIFACT_STORE_BUCKET: objectStoreBucketSchema,
  ARTIFACT_STORE_ENDPOINT: objectStoreEndpointSchema,
  ARTIFACT_STORE_FORCE_PATH_STYLE: objectStoreForcePathStyleSchema,
  ARTIFACT_STORE_REGION: z.string().trim().min(1),
  ARTIFACT_STORE_REQUEST_TIMEOUT_MS: objectStoreRequestTimeoutSchema,
  ARTIFACT_STORE_SECRET_ACCESS_KEY: z.string().min(1),
  ARTIFACT_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_CONFIGURABLE_OBJECT_BYTES)
    .default(DEFAULT_MAX_OBJECT_BYTES),
});

export interface ArtifactStoreConfig {
  readonly accessKeyId: string;
  readonly bucket: string;
  readonly endpoint: string;
  readonly forcePathStyle: boolean;
  readonly maxObjectBytes: number;
  readonly region: string;
  readonly requestTimeoutMs: number;
  readonly secretAccessKey: string;
}

export function parseArtifactStoreConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ArtifactStoreConfig {
  const parsed = artifactStoreEnvironmentSchema.parse(environment);
  return Object.freeze({
    accessKeyId: parsed.ARTIFACT_STORE_ACCESS_KEY_ID,
    bucket: parsed.ARTIFACT_STORE_BUCKET,
    endpoint: parsed.ARTIFACT_STORE_ENDPOINT,
    forcePathStyle: parsed.ARTIFACT_STORE_FORCE_PATH_STYLE === 'true',
    maxObjectBytes: parsed.ARTIFACT_MAX_BYTES,
    region: parsed.ARTIFACT_STORE_REGION,
    requestTimeoutMs: parsed.ARTIFACT_STORE_REQUEST_TIMEOUT_MS,
    secretAccessKey: parsed.ARTIFACT_STORE_SECRET_ACCESS_KEY,
  });
}
