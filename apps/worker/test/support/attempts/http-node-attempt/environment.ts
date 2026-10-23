import { randomUUID } from 'node:crypto';

import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';

import { createRedisTestNamespace } from '../../infrastructure/redis-test-namespace.js';

export const httpNodeAttemptIntegrationEnabled =
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true' &&
  process.env.ARTIFACT_STORE_INTEGRATION === 'true';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

export const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

export const apiUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

export const workerUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

export const operatorUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';

export const redisNamespace = createRedisTestNamespace(
  configuredRedisUrl,
  14,
  'http-node-attempt',
);

export const redisUrl = redisNamespace.redisUrl;

export const databaseName = `pertexo_test_http_attempt_${randomUUID().replaceAll('-', '')}`;

export const workspaceId = randomUUID();

export const actorId = randomUUID();

export const workflowId = randomUUID();

export const workflowVersionId = randomUUID();

export const connectionId = randomUUID();

export const secretVersionId = randomUUID();

export const slackConnectionId = randomUUID();

export const slackSecretVersionId = randomUUID();

export const emailConnectionId = randomUUID();

export const emailSecretVersionId = randomUUID();

export const rotatedEmailSecretVersionId = randomUUID();

export const plaintextSecret = `Bearer http-attempt-${randomUUID()}`;

export const slackBotToken = `xoxb-${randomUUID()}-secret`;

export const slackMessageText = `deployment-${randomUUID()}`;

export const resendApiKey = `re_${randomUUID().replaceAll('-', '')}`;

export const rotatedResendApiKey = `re_${randomUUID().replaceAll('-', '')}`;

export const emailRecipient = `recipient-${randomUUID()}@example.test`;

export const emailSubject = `subject-${randomUUID()}`;

export const emailText = `text-${randomUUID()}`;

export const responseBytes = 70_000;

export const activeCatalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);

export function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function redisConnection() {
  const parsed = new URL(redisUrl);
  return {
    db: Number(parsed.pathname.slice(1)),
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}
