import { testStackSetting } from '../../../../../../infrastructure/testing/test-stack.mjs';
import { randomUUID } from 'node:crypto';

import { fileURLToPath } from 'node:url';

import { describe } from 'vitest';

import { createRedisTestNamespace } from '../../../support/infrastructure/redis-test-namespace.js';

const enabled = process.env.WORKER_TRANSPORT_RESILIENCE === 'true';

export const describeResilience = enabled ? describe : describe.skip;

export const repositoryRoot = fileURLToPath(
  new URL('../../../../../../', import.meta.url),
);

export const REDIS_PROOF_DATABASE = 15;

export const SERVICE_OPERATION_TIMEOUT_MS = 120_000;

export const PROOF_OPERATION_TIMEOUT_MS = 10_000;

const migrationUrl = testStackSetting('DATABASE_MIGRATION_URL');

const apiUrl = testStackSetting('DATABASE_URL');

const dispatcherUrl = testStackSetting('DATABASE_MAINTENANCE_URL');

const configuredRedisUrl = testStackSetting('REDIS_URL');

export const redisPassword = testStackSetting('REDIS_PASSWORD');

export const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';

const adminUrl = testStackSetting('DATABASE_ADMIN_URL');

export const databaseName = `pertexo_test_transport_resilience_${randomUUID().replaceAll('-', '')}`;

function localUrl(
  value: string,
  label: string,
  protocol: 'postgresql:' | 'redis:',
): URL {
  const parsed = new URL(value);
  if (
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    parsed.protocol !== protocol
  ) {
    throw new Error(
      `${label} must target a local generated Compose dependency`,
    );
  }
  return parsed;
}

export const localAdminUrl = localUrl(
  adminUrl,
  'DATABASE_ADMIN_URL',
  'postgresql:',
);

const localMigrationBaseUrl = localUrl(
  migrationUrl,
  'DATABASE_MIGRATION_URL',
  'postgresql:',
);

const localApiBaseUrl = localUrl(apiUrl, 'DATABASE_URL', 'postgresql:');

const localDispatcherBaseUrl = localUrl(
  dispatcherUrl,
  'DATABASE_MAINTENANCE_URL',
  'postgresql:',
);

function disposableDatabaseUrl(baseUrl: URL): URL {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed;
}

export const localMigrationUrl = disposableDatabaseUrl(localMigrationBaseUrl);

export const localApiUrl = disposableDatabaseUrl(localApiBaseUrl);

export const localDispatcherUrl = disposableDatabaseUrl(localDispatcherBaseUrl);

export const redisNamespace = createRedisTestNamespace(
  localUrl(configuredRedisUrl, 'REDIS_URL', 'redis:').toString(),
  REDIS_PROOF_DATABASE,
  'transport-resilience',
);

export const redisUrl = redisNamespace.redisUrl;

export function redisConnection(): {
  db: number;
  host: string;
  password?: string;
  port: number;
} {
  const parsed = new URL(redisUrl);
  return {
    db: REDIS_PROOF_DATABASE,
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}
