import { fileURLToPath } from 'node:url';

import { describe } from 'vitest';

// These tests stop Postgres, Redis and the object store on their compose
// project, so they run on their own CI runner rather than beside other suites.
export const describeFaults =
  process.env.WORKER_FAULT_TESTS === 'true' ? describe : describe.skip;

export const repositoryRoot = fileURLToPath(
  new URL('../../../../../', import.meta.url),
);

/**
 * How long, on default worker settings, a run may wait for automatic recovery
 * after its worker is gone: the 30 s lease, a scan, then real work on a loaded
 * CI runner. A run still active past this is treated as stuck.
 */
export const RECOVERY_LIMIT_MS = 150_000;

/** Waits for every scenario's setup and for its services to come back. */
export const SCENARIO_LIMIT_MS = 600_000;

const value = (name: string, fallback: string): string =>
  process.env[name] ?? fallback;

export const composeUrls = Object.freeze({
  admin: value(
    'DATABASE_ADMIN_URL',
    'postgresql://postgres:pertexo-local-superuser@127.0.0.1:5432/postgres',
  ),
  app: value(
    'DATABASE_URL',
    'postgresql://pertexo_app:pertexo-local-app@127.0.0.1:5432/pertexo',
  ),
  maintenance: value(
    'DATABASE_MAINTENANCE_URL',
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@127.0.0.1:5432/pertexo',
  ),
  migration: value(
    'DATABASE_MIGRATION_URL',
    'postgresql://pertexo_migration:pertexo-local-migration@127.0.0.1:5432/pertexo',
  ),
  redis: value('REDIS_URL', 'redis://:pertexo-local-redis@127.0.0.1:6379/0'),
});

export const roles = Object.freeze({
  app: value('POSTGRES_APP_USER', 'pertexo_app'),
  maintenance: value('POSTGRES_MAINTENANCE_USER', 'pertexo_maintenance'),
  migration: value('POSTGRES_MIGRATION_USER', 'pertexo_migration'),
  owner: value('POSTGRES_OWNER_USER', 'pertexo_owner'),
});

export const redisPassword = value('REDIS_PASSWORD', 'pertexo-local-redis');

/** Everything the API and worker read, with development keys and default bounds. */
export const serviceEnvironment = Object.freeze({
  ARTIFACT_STORE_ACCESS_KEY_ID: value(
    'ARTIFACT_STORE_ACCESS_KEY_ID',
    'pertexo-local-access-key',
  ),
  ARTIFACT_STORE_BUCKET: value('ARTIFACT_STORE_BUCKET', 'pertexo-artifacts'),
  ARTIFACT_STORE_ENDPOINT: value(
    'ARTIFACT_STORE_ENDPOINT',
    'http://127.0.0.1:9090',
  ),
  ARTIFACT_STORE_FORCE_PATH_STYLE: 'true',
  ARTIFACT_STORE_REGION: value('ARTIFACT_STORE_REGION', 'us-east-1'),
  ARTIFACT_STORE_SECRET_ACCESS_KEY: value(
    'ARTIFACT_STORE_SECRET_ACCESS_KEY',
    'pertexo-local-secret-key',
  ),
  AUTH_MAIL_MODE: 'local',
  AUTOMATION_TOKENS_ENABLED: 'true',
  BETTER_AUTH_SECRET:
    'pertexo-local-better-auth-secret-change-before-deployment',
  CALLBACK_TOKEN_KEY: 'RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkY',
  CALLBACK_TOKEN_KEY_VERSION: 'v1',
  CODE_STEPS_ENABLED: 'false',
  CONNECTION_ENCRYPTION_MODE: 'self-managed',
  CONNECTION_SELF_MANAGED_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  CONNECTION_SELF_MANAGED_KEY_VERSION: 'local:development',
  HTTP_ALLOWED_PRIVATE_NETWORKS: '127.0.0.1/32',
  LOG_LEVEL: 'info',
  NODE_ENV: 'development',
  SERVICE_VERSION: '0.0.0-dev',
  ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
  ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
  ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
});
