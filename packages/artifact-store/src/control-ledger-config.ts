import { z } from 'zod';

import {
  objectStoreBucketSchema,
  objectStoreEndpointSchema,
  objectStoreForcePathStyleSchema,
  objectStoreRequestTimeoutSchema,
} from './config-primitives.js';

const controlLedgerEnvironmentSchema = z.object({
  CONTROL_LEDGER_ACCESS_KEY_ID: z.string().trim().min(1),
  CONTROL_LEDGER_BUCKET: objectStoreBucketSchema,
  CONTROL_LEDGER_ENDPOINT: objectStoreEndpointSchema,
  CONTROL_LEDGER_FORCE_PATH_STYLE: objectStoreForcePathStyleSchema,
  CONTROL_LEDGER_MIN_RETENTION_DAYS: z.coerce.number().int().positive(),
  CONTROL_LEDGER_REGION: z.string().trim().min(1),
  CONTROL_LEDGER_REQUEST_TIMEOUT_MS: objectStoreRequestTimeoutSchema,
  CONTROL_LEDGER_SECRET_ACCESS_KEY: z.string().min(1),
});

const recoveryControlLedgerEnvironmentSchema = z.object({
  CONTROL_LEDGER_RECOVERY_ACCESS_KEY_ID: z.string().trim().min(1),
  CONTROL_LEDGER_RECOVERY_BUCKET: objectStoreBucketSchema,
  CONTROL_LEDGER_RECOVERY_ENDPOINT: objectStoreEndpointSchema,
  CONTROL_LEDGER_RECOVERY_FORCE_PATH_STYLE: objectStoreForcePathStyleSchema,
  CONTROL_LEDGER_RECOVERY_MIN_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .positive(),
  CONTROL_LEDGER_RECOVERY_REGION: z.string().trim().min(1),
  CONTROL_LEDGER_RECOVERY_REQUEST_TIMEOUT_MS: objectStoreRequestTimeoutSchema,
  CONTROL_LEDGER_RECOVERY_SECRET_ACCESS_KEY: z.string().min(1),
});

/** Dedicated principal and bucket boundary for immutable control records. */
export interface ControlLedgerConfig {
  readonly accessKeyId: string;
  readonly bucket: string;
  readonly endpoint: string;
  readonly forcePathStyle: boolean;
  readonly minRetentionDays: number;
  readonly region: string;
  readonly requestTimeoutMs: number;
  readonly secretAccessKey: string;
}

export interface DualRegionControlLedgerConfig {
  readonly primary: ControlLedgerConfig;
  readonly recovery: ControlLedgerConfig;
}

export function parseControlLedgerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ControlLedgerConfig {
  const parsed = controlLedgerEnvironmentSchema.parse(environment);
  if (
    environment.ARTIFACT_STORE_BUCKET !== undefined &&
    parsed.CONTROL_LEDGER_BUCKET === environment.ARTIFACT_STORE_BUCKET
  ) {
    throw new Error(
      'CONTROL_LEDGER_BUCKET must be distinct from ARTIFACT_STORE_BUCKET',
    );
  }
  return Object.freeze({
    accessKeyId: parsed.CONTROL_LEDGER_ACCESS_KEY_ID,
    bucket: parsed.CONTROL_LEDGER_BUCKET,
    endpoint: parsed.CONTROL_LEDGER_ENDPOINT,
    forcePathStyle: parsed.CONTROL_LEDGER_FORCE_PATH_STYLE === 'true',
    minRetentionDays: parsed.CONTROL_LEDGER_MIN_RETENTION_DAYS,
    region: parsed.CONTROL_LEDGER_REGION,
    requestTimeoutMs: parsed.CONTROL_LEDGER_REQUEST_TIMEOUT_MS,
    secretAccessKey: parsed.CONTROL_LEDGER_SECRET_ACCESS_KEY,
  });
}

export function parseDualRegionControlLedgerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DualRegionControlLedgerConfig {
  const primary = parseControlLedgerConfig(environment);
  const parsed = recoveryControlLedgerEnvironmentSchema.parse(environment);
  const recovery = Object.freeze({
    accessKeyId: parsed.CONTROL_LEDGER_RECOVERY_ACCESS_KEY_ID,
    bucket: parsed.CONTROL_LEDGER_RECOVERY_BUCKET,
    endpoint: parsed.CONTROL_LEDGER_RECOVERY_ENDPOINT,
    forcePathStyle: parsed.CONTROL_LEDGER_RECOVERY_FORCE_PATH_STYLE === 'true',
    minRetentionDays: parsed.CONTROL_LEDGER_RECOVERY_MIN_RETENTION_DAYS,
    region: parsed.CONTROL_LEDGER_RECOVERY_REGION,
    requestTimeoutMs: parsed.CONTROL_LEDGER_RECOVERY_REQUEST_TIMEOUT_MS,
    secretAccessKey: parsed.CONTROL_LEDGER_RECOVERY_SECRET_ACCESS_KEY,
  });
  if (primary.region === recovery.region) {
    throw new Error(
      'Control ledger primary and recovery regions must be distinct',
    );
  }
  if (primary.bucket === recovery.bucket) {
    throw new Error(
      'Control ledger primary and recovery buckets must be distinct',
    );
  }
  if (primary.accessKeyId === recovery.accessKeyId) {
    throw new Error(
      'Control ledger primary and recovery access key IDs must be distinct',
    );
  }
  if (
    environment.ARTIFACT_STORE_BUCKET !== undefined &&
    recovery.bucket === environment.ARTIFACT_STORE_BUCKET
  ) {
    throw new Error(
      'CONTROL_LEDGER_RECOVERY_BUCKET must be distinct from ARTIFACT_STORE_BUCKET',
    );
  }
  return Object.freeze({ primary, recovery });
}
