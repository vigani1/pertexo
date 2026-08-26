import {
  parseMaintenanceDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database';
import {
  parseObservabilityConfig,
  type ObservabilityConfig,
} from '@pertexo/observability/config';
import { z } from 'zod';

const environmentSchema = z.object({
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
  RETENTION_LEASE_SECONDS: z.coerce.number().int().min(1).max(300).default(300),
  RETENTION_MAX_PAGES_PER_BATCH: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(1_000),
  RETENTION_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  RETENTION_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(1_000),
  SERVICE_VERSION: z.string().trim().min(1).default('0.0.0-dev'),
});

export interface RetentionWorkerConfig {
  readonly database: DatabaseConfig;
  readonly expectedMaintenanceRole: string;
  readonly observability: ObservabilityConfig;
  readonly options: Readonly<{
    leaseOwner: string;
    leaseSeconds: number;
    maxPagesPerBatch: number;
    pageSize: number;
  }>;
  readonly pollIntervalMs: number;
}

export function parseRetentionWorkerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RetentionWorkerConfig {
  const parsed = environmentSchema.parse(environment);
  return Object.freeze({
    database: parseMaintenanceDatabaseConfig(environment),
    expectedMaintenanceRole: parsed.POSTGRES_MAINTENANCE_USER,
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
      maxPagesPerBatch: parsed.RETENTION_MAX_PAGES_PER_BATCH,
      pageSize: parsed.RETENTION_PAGE_SIZE,
    }),
    pollIntervalMs: parsed.RETENTION_POLL_INTERVAL_MS,
  });
}
