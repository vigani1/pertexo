import { testStackSetting } from '../../../../../infrastructure/testing/test-stack.mjs';
import { randomUUID } from 'node:crypto';

export const adminUrl = testStackSetting('DATABASE_ADMIN_URL');

const migrationBaseUrl = testStackSetting('DATABASE_MIGRATION_URL');

const apiBaseUrl = testStackSetting('DATABASE_URL');

export const databaseName = `pertexo_test_auth_${randomUUID().replaceAll('-', '')}`;

export function databaseUrl(base: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

export const migrationUrl = databaseUrl(migrationBaseUrl);

export const apiUrl = databaseUrl(apiBaseUrl);
