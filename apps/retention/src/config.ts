import {
  parseMaintenanceDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database';
import {
  parseArtifactStoreConfig,
  parseDualRegionControlLedgerConfig,
  type ArtifactStoreConfig,
  type DualRegionControlLedgerConfig,
} from '@pertexo/artifact-store';
import {
  parseObservabilityConfig,
  type ObservabilityConfig,
} from '@pertexo/observability/config';
import { z } from 'zod';

const environmentSchema = z
  .object({
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    NODE_ENV: z
      .enum(['development', 'test', 'staging', 'production'])
      .default('development'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    POSTGRES_MAINTENANCE_USER: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/u)
      .default('pertexo_maintenance'),
    RETENTION_LEASE_OWNER: z.string().trim().min(1).max(128),
    RETENTION_LEASE_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(300)
      .default(300),
    RETENTION_MAX_PAGES_PER_BATCH: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(1_000),
    RETENTION_EXTERNAL_OPERATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
    RETENTION_DATABASE_LOCK_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(10_000),
    RETENTION_DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
    RETENTION_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
    RETENTION_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(1_000),
    SERVICE_VERSION: z.string().trim().min(1).default('0.0.0-dev'),
  })
  .superRefine((value, context) => {
    if (
      value.RETENTION_EXTERNAL_OPERATION_TIMEOUT_MS +
        value.RETENTION_DATABASE_STATEMENT_TIMEOUT_MS >=
      value.RETENTION_LEASE_SECONDS * 1_000
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Retention timeout budget must be shorter than the lease',
        path: ['RETENTION_LEASE_SECONDS'],
      });
    }
  });

export interface RetentionWorkerConfig {
  readonly artifactStore: ArtifactStoreConfig;
  readonly database: DatabaseConfig;
  readonly expectedMaintenanceRole: string;
  readonly ledger: DualRegionControlLedgerConfig;
  readonly observability: ObservabilityConfig;
  readonly options: Readonly<{
    leaseOwner: string;
    leaseSeconds: number;
    externalOperationTimeoutMs: number;
    lockTimeoutMs: number;
    maxPagesPerBatch: number;
    pageSize: number;
    statementTimeoutMs: number;
  }>;
  readonly pollIntervalMs: number;
}

export function parseRetentionWorkerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RetentionWorkerConfig {
  const parsed = environmentSchema.parse(environment);
  const artifactStore = parseArtifactStoreConfig(environment);
  const ledger = parseDualRegionControlLedgerConfig(environment);
  if (
    [ledger.primary, ledger.recovery].some(
      (control) =>
        control.accessKeyId === artifactStore.accessKeyId ||
        control.bucket === artifactStore.bucket,
    )
  )
    throw new Error(
      'Tenant artifacts and control ledgers require distinct principals and buckets',
    );
  return Object.freeze({
    artifactStore,
    database: parseMaintenanceDatabaseConfig(environment),
    expectedMaintenanceRole: parsed.POSTGRES_MAINTENANCE_USER,
    ledger,
    observability: parseObservabilityConfig({
      environment: parsed.NODE_ENV,
      logLevel: parsed.LOG_LEVEL,
      ...(parsed.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
        ? {}
        : { otlpHttpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT }),
      serviceName: 'pertexo-retention',
      serviceVersion: parsed.SERVICE_VERSION,
    }),
    options: Object.freeze({
      leaseOwner: parsed.RETENTION_LEASE_OWNER,
      leaseSeconds: parsed.RETENTION_LEASE_SECONDS,
      externalOperationTimeoutMs:
        parsed.RETENTION_EXTERNAL_OPERATION_TIMEOUT_MS,
      lockTimeoutMs: parsed.RETENTION_DATABASE_LOCK_TIMEOUT_MS,
      maxPagesPerBatch: parsed.RETENTION_MAX_PAGES_PER_BATCH,
      pageSize: parsed.RETENTION_PAGE_SIZE,
      statementTimeoutMs: parsed.RETENTION_DATABASE_STATEMENT_TIMEOUT_MS,
    }),
    pollIntervalMs: parsed.RETENTION_POLL_INTERVAL_MS,
  });
}
