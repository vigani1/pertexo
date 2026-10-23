import { randomUUID } from 'node:crypto';

import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

export const adminBaseUrl = process.env.DATABASE_ADMIN_URL;

export const migrationBaseUrl = process.env.DATABASE_MIGRATION_URL;

export const apiBaseUrl = process.env.DATABASE_URL;

export const requested = process.env.API_WEBHOOK_INTEGRATION === 'true';

export const enabled = requested;

export const runnerOwnsDatabase =
  process.env.PERTEXO_Q11_RUNNER_OWNS_DATABASE === '1';

export const databaseName = (() => {
  if (!runnerOwnsDatabase)
    return `pertexo_test_api_webhook_${randomUUID().replaceAll('-', '')}`;
  const value = process.env.PERTEXO_Q11_DATABASE_NAME;
  if (!value) throw new Error('Q11 runner-owned database name is required');
  return value;
})();

const databaseUrl = (base: string): string => {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

export const configuredDatabaseUrl = (base: string | undefined): string =>
  databaseUrl(base ?? 'postgresql://integration-disabled@127.0.0.1:1/unused');

export const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';

export const migrationRole =
  process.env.POSTGRES_MIGRATION_USER ?? 'pertexo_migration';

export const appRole = process.env.POSTGRES_APP_USER ?? 'pertexo_app';

export const maintenanceRole =
  process.env.POSTGRES_MAINTENANCE_USER ?? 'pertexo_maintenance';

export const logger: StructuredLogger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
};

export const telemetry: TelemetryLifecycle = {
  enabled: false,
  started: false,
  start: () => undefined,
  shutdown: () => Promise.resolve(),
};

export function quoteIdentifier(value: string): string {
  if (value.length === 0 || value.includes('\0'))
    throw new Error('PostgreSQL role or database identifier is invalid');
  return `"${value.replaceAll('"', '""')}"`;
}
