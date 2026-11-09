import type { DatabaseConfig } from '@pertexo/database/platform';

/** Keep each fixture database isolated while exercising the real organization login. */
export function maintenanceDatabase(database: DatabaseConfig): DatabaseConfig {
  const url = new URL(
    process.env.DATABASE_MAINTENANCE_URL ??
      'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
  );
  url.pathname = new URL(database.connectionString).pathname;
  return { ...database, connectionString: url.toString() };
}
