import {
  parseDualRegionControlLedgerConfig,
  type DualRegionControlLedgerConfig,
} from '@pertexo/artifact-store';
import {
  parseLifecycleCommandDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database/lifecycle';
import {
  parseObservabilityConfig,
  type ObservabilityConfig,
} from '@pertexo/observability/config';
import { z } from 'zod';

const environmentSchema = z
  .object({
    LIFECYCLE_COMMAND_DATABASE_LOCK_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(10_000),
    LIFECYCLE_COMMAND_DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
    LIFECYCLE_COMMAND_EXTERNAL_OPERATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
    LIFECYCLE_COMMAND_LEASE_DURATION_MS: z.coerce
      .number()
      .int()
      .min(2_000)
      .max(300_000)
      .default(180_000),
    LIFECYCLE_COMMAND_LEASE_OWNER: z.string().trim().min(1).max(128),
    LIFECYCLE_COMMAND_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(1_000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    NODE_ENV: z
      .enum(['development', 'test', 'staging', 'production'])
      .default('development'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    POSTGRES_LIFECYCLE_COMMAND_USER: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/u)
      .default('pertexo_lifecycle_command'),
    SERVICE_VERSION: z.string().trim().min(1).default('0.0.0-dev'),
  })
  .superRefine((value, context) => {
    if (
      value.NODE_ENV === 'production' &&
      value.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
    )
      context.addIssue({
        code: 'custom',
        message: 'Production lifecycle worker requires OTLP telemetry export',
        path: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
      });
    if (
      value.LIFECYCLE_COMMAND_EXTERNAL_OPERATION_TIMEOUT_MS +
        value.LIFECYCLE_COMMAND_DATABASE_STATEMENT_TIMEOUT_MS * 4 +
        5_000 >=
      value.LIFECYCLE_COMMAND_LEASE_DURATION_MS
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Lifecycle command timeout budget must be shorter than the lease',
        path: ['LIFECYCLE_COMMAND_LEASE_DURATION_MS'],
      });
    }
  });

export interface LifecycleCommandConfig {
  readonly coordinator: Readonly<{
    externalOperationTimeoutMs: number;
    leaseDurationMs: number;
    leaseOwner: string;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
  }>;
  readonly database: DatabaseConfig;
  readonly lifecycleCommandRole: string;
  readonly ledger: DualRegionControlLedgerConfig;
  readonly observability: ObservabilityConfig;
  readonly pollIntervalMs: number;
}

export function parseLifecycleCommandConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LifecycleCommandConfig {
  const parsed = environmentSchema.parse(environment);
  return Object.freeze({
    coordinator: Object.freeze({
      externalOperationTimeoutMs:
        parsed.LIFECYCLE_COMMAND_EXTERNAL_OPERATION_TIMEOUT_MS,
      leaseDurationMs: parsed.LIFECYCLE_COMMAND_LEASE_DURATION_MS,
      leaseOwner: parsed.LIFECYCLE_COMMAND_LEASE_OWNER,
      lockTimeoutMs: parsed.LIFECYCLE_COMMAND_DATABASE_LOCK_TIMEOUT_MS,
      statementTimeoutMs:
        parsed.LIFECYCLE_COMMAND_DATABASE_STATEMENT_TIMEOUT_MS,
    }),
    database: parseLifecycleCommandDatabaseConfig(environment),
    lifecycleCommandRole: parsed.POSTGRES_LIFECYCLE_COMMAND_USER,
    ledger: parseDualRegionControlLedgerConfig(environment),
    observability: parseObservabilityConfig({
      environment: parsed.NODE_ENV,
      logLevel: parsed.LOG_LEVEL,
      ...(parsed.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
        ? {}
        : { otlpHttpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT }),
      serviceName: 'pertexo-lifecycle-command',
      serviceVersion: parsed.SERVICE_VERSION,
    }),
    pollIntervalMs: parsed.LIFECYCLE_COMMAND_POLL_INTERVAL_MS,
  });
}
