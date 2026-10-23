import { randomUUID } from 'node:crypto';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

export const databaseName = `pertexo_test_auth_${randomUUID().replaceAll('-', '')}`;

export function databaseUrl(base: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

export const migrationUrl = databaseUrl(migrationBaseUrl);

export const apiUrl = databaseUrl(apiBaseUrl);
