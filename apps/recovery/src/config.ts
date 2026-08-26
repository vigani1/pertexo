import {
  parseDualRegionControlLedgerConfig,
  type DualRegionControlLedgerConfig,
} from '@pertexo/artifact-store';
import {
  parseMaintenanceDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database';
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
    RESTORE_DATABASE_LOCK_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(300_000)
      .default(10_000),
    RESTORE_DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    RESTORE_EXTERNAL_OPERATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(120_000),
    RESTORE_INVENTORY_PAGE_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(100),
    RESTORE_LEDGER_MAX_PAGES: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(10),
    RESTORE_LEDGER_MAX_RECORDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(1_000),
    RESTORE_LEDGER_PAGE_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(100),
    RESTORE_MAX_INVENTORY_PAGES: z.coerce
      .number()
      .int()
      .min(1)
      .max(100_000)
      .default(10_000),
    RESTORE_MAX_INVENTORY_SWEEPS: z.coerce
      .number()
      .int()
      .min(2)
      .max(100)
      .default(3),
    RESTORE_MAX_WORKSPACE_RECONCILE_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(10),
    RESTORE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(86_400_000)
      .default(21_600_000),
    SERVICE_VERSION: z.string().trim().min(1).default('0.0.0-dev'),
  })
  .superRefine((value, context) => {
    if (value.RESTORE_LEDGER_PAGE_SIZE > value.RESTORE_LEDGER_MAX_RECORDS) {
      context.addIssue({
        code: 'custom',
        message: 'RESTORE_LEDGER_PAGE_SIZE cannot exceed the record bound',
        path: ['RESTORE_LEDGER_PAGE_SIZE'],
      });
    }
    if (
      value.RESTORE_LEDGER_MAX_RECORDS >
      value.RESTORE_LEDGER_MAX_PAGES * value.RESTORE_LEDGER_PAGE_SIZE
    ) {
      context.addIssue({
        code: 'custom',
        message: 'RESTORE_LEDGER_MAX_RECORDS exceeds page capacity',
        path: ['RESTORE_LEDGER_MAX_RECORDS'],
      });
    }
  });

export interface RecoveryConfig {
  readonly coordinator: Readonly<{
    externalOperationTimeoutMs: number;
    inventoryPageSize: number;
    lockTimeoutMs: number;
    maxInventoryPages: number;
    maxInventorySweeps: number;
    maxPages: number;
    maxRecords: number;
    maxWorkspaceReconcileAttempts: number;
    pageSize: number;
    statementTimeoutMs: number;
  }>;
  readonly database: DatabaseConfig;
  readonly ledger: DualRegionControlLedgerConfig;
  readonly maintenanceRole: string;
  readonly observability: ObservabilityConfig;
  readonly timeoutMs: number;
}

export function parseRecoveryConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RecoveryConfig {
  const parsed = environmentSchema.parse(environment);
  return Object.freeze({
    coordinator: Object.freeze({
      externalOperationTimeoutMs: parsed.RESTORE_EXTERNAL_OPERATION_TIMEOUT_MS,
      inventoryPageSize: parsed.RESTORE_INVENTORY_PAGE_SIZE,
      lockTimeoutMs: parsed.RESTORE_DATABASE_LOCK_TIMEOUT_MS,
      maxInventoryPages: parsed.RESTORE_MAX_INVENTORY_PAGES,
      maxInventorySweeps: parsed.RESTORE_MAX_INVENTORY_SWEEPS,
      maxPages: parsed.RESTORE_LEDGER_MAX_PAGES,
      maxRecords: parsed.RESTORE_LEDGER_MAX_RECORDS,
      maxWorkspaceReconcileAttempts:
        parsed.RESTORE_MAX_WORKSPACE_RECONCILE_ATTEMPTS,
      pageSize: parsed.RESTORE_LEDGER_PAGE_SIZE,
      statementTimeoutMs: parsed.RESTORE_DATABASE_STATEMENT_TIMEOUT_MS,
    }),
    database: parseMaintenanceDatabaseConfig(environment),
    ledger: parseDualRegionControlLedgerConfig(environment),
    maintenanceRole: parsed.POSTGRES_MAINTENANCE_USER,
    observability: parseObservabilityConfig({
      environment: parsed.NODE_ENV,
      logLevel: parsed.LOG_LEVEL,
      ...(parsed.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
        ? {}
        : { otlpHttpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT }),
      serviceName: 'pertexo-restore-recovery',
      serviceVersion: parsed.SERVICE_VERSION,
    }),
    timeoutMs: parsed.RESTORE_TIMEOUT_MS,
  });
}
