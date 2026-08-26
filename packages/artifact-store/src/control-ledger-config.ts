import { z } from 'zod';

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

const controlLedgerEnvironmentSchema = z.object({
  CONTROL_LEDGER_ACCESS_KEY_ID: z.string().trim().min(1),
  CONTROL_LEDGER_BUCKET: bucketSchema,
  CONTROL_LEDGER_ENDPOINT: endpointSchema,
  CONTROL_LEDGER_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true'),
  CONTROL_LEDGER_MIN_RETENTION_DAYS: z.coerce.number().int().positive(),
  CONTROL_LEDGER_REGION: z.string().trim().min(1),
  CONTROL_LEDGER_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5_000),
  CONTROL_LEDGER_SECRET_ACCESS_KEY: z.string().min(1),
});

const recoveryControlLedgerEnvironmentSchema = z.object({
  CONTROL_LEDGER_RECOVERY_ACCESS_KEY_ID: z.string().trim().min(1),
  CONTROL_LEDGER_RECOVERY_BUCKET: bucketSchema,
  CONTROL_LEDGER_RECOVERY_ENDPOINT: endpointSchema,
  CONTROL_LEDGER_RECOVERY_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true'),
  CONTROL_LEDGER_RECOVERY_MIN_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .positive(),
  CONTROL_LEDGER_RECOVERY_REGION: z.string().trim().min(1),
  CONTROL_LEDGER_RECOVERY_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5_000),
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
