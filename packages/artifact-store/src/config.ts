import { z } from 'zod';

const DEFAULT_MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const MAX_CONFIGURABLE_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;

const endpointSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === ''
  );
}, 'must be an HTTP(S) URL without embedded credentials');

const bucketSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u)
  .refine((value) => !value.includes('..'), 'must not contain adjacent dots')
  .refine(
    (value) => !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value),
    'must not be formatted as an IP address',
  );

const artifactStoreEnvironmentSchema = z.object({
  ARTIFACT_STORE_ACCESS_KEY_ID: z.string().trim().min(1),
  ARTIFACT_STORE_BUCKET: bucketSchema,
  ARTIFACT_STORE_ENDPOINT: endpointSchema,
  ARTIFACT_STORE_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true'),
  ARTIFACT_STORE_REGION: z.string().trim().min(1),
  ARTIFACT_STORE_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5_000),
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

export interface DualRegionArtifactStoreConfig {
  readonly primary: ArtifactStoreConfig;
  readonly recovery: ArtifactStoreConfig;
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

export function parseDualRegionArtifactStoreConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DualRegionArtifactStoreConfig {
  const primary = parseArtifactStoreConfig(environment);
  const recovery = parseArtifactStoreConfig({
    ARTIFACT_MAX_BYTES: environment.ARTIFACT_MAX_BYTES,
    ARTIFACT_STORE_ACCESS_KEY_ID:
      environment.ARTIFACT_STORE_RECOVERY_ACCESS_KEY_ID,
    ARTIFACT_STORE_BUCKET: environment.ARTIFACT_STORE_RECOVERY_BUCKET,
    ARTIFACT_STORE_ENDPOINT: environment.ARTIFACT_STORE_RECOVERY_ENDPOINT,
    ARTIFACT_STORE_FORCE_PATH_STYLE:
      environment.ARTIFACT_STORE_RECOVERY_FORCE_PATH_STYLE,
    ARTIFACT_STORE_REGION: environment.ARTIFACT_STORE_RECOVERY_REGION,
    ARTIFACT_STORE_REQUEST_TIMEOUT_MS:
      environment.ARTIFACT_STORE_RECOVERY_REQUEST_TIMEOUT_MS ??
      environment.ARTIFACT_STORE_REQUEST_TIMEOUT_MS,
    ARTIFACT_STORE_SECRET_ACCESS_KEY:
      environment.ARTIFACT_STORE_RECOVERY_SECRET_ACCESS_KEY,
  });
  if (
    primary.accessKeyId === recovery.accessKeyId ||
    primary.bucket === recovery.bucket ||
    primary.region === recovery.region
  )
    throw new Error(
      'Artifact primary and recovery access key IDs, buckets, and regions must be distinct',
    );
  if (primary.maxObjectBytes !== recovery.maxObjectBytes)
    throw new Error('Artifact primary and recovery byte limits must match');
  return Object.freeze({ primary, recovery });
}
