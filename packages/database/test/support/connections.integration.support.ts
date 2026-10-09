import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { DatabaseError, PoolClient } from 'pg';
import { afterAll, beforeAll } from 'vitest';

import {
  CONNECTION_AUTH_TYPE,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionNotFoundError,
  ConnectionSecretVersionConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
  createConnectionDatabase,
  type ConnectionDatabase,
  type ConnectionLookupDatabase,
  type CreateConnectionInput,
} from '../../src/connections/database.js';
import {
  createFailureNotificationDestinationDatabase,
  FailureNotificationDestinationError,
  type FailureNotificationDestinationDatabase,
} from '../../src/notifications/destinations/repository.js';
import { createFailureNotificationStore } from '../../src/notifications/store.js';
import { parseDatabaseConfig } from '../../src/config.js';
import { migrateDatabase } from '../../src/migrations.js';
import { canonicalOutboxPayloadChecksum } from '../../src/outbox/events.js';
import { dropDisconnectedDatabase } from './disposable-database.js';
import { checkDatabaseReadiness } from '../../src/platform/readiness.js';
import { generatePersistedId } from '../../src/platform/persisted-id.js';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
export const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
export const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
export const workerBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
export const databaseName = `pertexo_test_connections_${randomUUID().replaceAll('-', '')}`;
export const workspaceA = randomUUID();
export const workspaceB = randomUUID();
export const ownerA = randomUUID();
export const ownerB = randomUUID();
export const historicalWorkspaceId = randomUUID();
export const historicalOwnerId = randomUUID();
export const historicalRunId = randomUUID();
export const historicalIntentId = randomUUID();
export const historicalRetryIntentId = randomUUID();
export const historicalDispatchingIntentId = randomUUID();
export const historicalDestinationId = randomUUID();
export const historicalOutboxByIntent = new Map(
  [
    historicalIntentId,
    historicalRetryIntentId,
    historicalDispatchingIntentId,
  ].map((intentId) => [intentId, randomUUID()]),
);

export type CurrentConnectionsFixture = Readonly<{
  api: ConnectionDatabase & ConnectionLookupDatabase;
  worker: ConnectionDatabase;
  destinations: FailureNotificationDestinationDatabase;
}>;

export function databaseUrl(base: string, name = databaseName): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

export function pgCode(expected: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    while (current instanceof Error) {
      if ((current as DatabaseError).code === expected) return true;
      current = current.cause;
    }
    return false;
  };
}

export async function createDatabase(name: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${name}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${name}" from public`);
    await admin.query(
      `grant connect on database "${name}" to pertexo_migration, pertexo_app, pertexo_app, pertexo_maintenance`,
    );
  } finally {
    await admin.end();
  }
}

export async function dropDatabase(name: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, name);
  } finally {
    await admin.end();
  }
}

export function migrationConfig(name = databaseName) {
  return {
    appRole: 'pertexo_app',
    connectionString: databaseUrl(migrationBaseUrl, name),
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  } as const;
}

export async function seedWorkspaces(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    for (const [workspaceId, ownerId, suffix] of [
      [workspaceA, ownerA, 'a'],
      [workspaceB, ownerB, 'b'],
    ] as const) {
      await client.query(
        `insert into app.users (id, email, display_name, status)
         values ($1, $2, $3, 'active')`,
        [ownerId, `connection-${suffix}@example.test`, `Owner ${suffix}`],
      );
      await client.query(
        `insert into app.workspaces
           (id, name, slug, status, created_by)
         values ($1, $2, $3, 'active', $4)`,
        [workspaceId, `Workspace ${suffix}`, `connection-${suffix}`, ownerId],
      );
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.workspace_memberships
           (workspace_id, user_id, role, status)
         values ($1, $2, 'owner', 'active')`,
        [workspaceId, ownerId],
      );
    }
    await client.query('commit');
  } catch (error: unknown) {
    await client?.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

export const sealed = (marker: number) => ({
  schemaVersion: 1 as const,
  kmsKeyReference: 'arn:aws:kms:eu-central-1:123456789012:key/example',
  encryptedDataKey: Buffer.alloc(96, marker).toString('base64url'),
  ciphertext: Buffer.from(`encrypted-${String(marker)}`).toString('base64url'),
  nonce: Buffer.alloc(12, marker).toString('base64url'),
  tag: Buffer.alloc(16, marker).toString('base64url'),
});

export function createInput(
  overrides: Partial<CreateConnectionInput> = {},
): CreateConnectionInput {
  const connectionId = overrides.connectionId ?? generatePersistedId();
  const secretVersionId = overrides.secretVersionId ?? randomUUID();
  const name = overrides.name ?? `HTTP ${connectionId}`;
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ name, connectionId }))
    .digest('hex');
  return {
    workspaceId: workspaceA,
    actorId: ownerA,
    connectionId,
    secretVersionId,
    providerKey: 'http',
    name,
    authType: CONNECTION_AUTH_TYPE.httpHeaders,
    sealed: sealed(1),
    idempotencyKey: `create-${connectionId}`,
    requestHash,
    requestId: `request-${connectionId}`,
    traceId: `trace-${connectionId}`,
    ...overrides,
  };
}

export function registerCurrentConnectionsFixture(): CurrentConnectionsFixture {
  let api: (ConnectionDatabase & ConnectionLookupDatabase) | undefined;
  let worker: ConnectionDatabase | undefined;
  let destinations: FailureNotificationDestinationDatabase | undefined;
  const resources: { close(): Promise<void> }[] = [];
  beforeAll(async () => {
    await createDatabase(databaseName);
    await migrateDatabase(migrationConfig());
    await seedWorkspaces();
    api = createConnectionDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(apiBaseUrl),
        max: 4,
      }),
    );
    resources.push(api);
    worker = createConnectionDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 4,
      }),
    );
    resources.push(worker);
    destinations = createFailureNotificationDestinationDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(apiBaseUrl),
        max: 4,
      }),
    );
    resources.push(destinations);
  });

  afterAll(async () => {
    const settled = await Promise.allSettled(
      resources.map((resource) => resource.close()),
    );
    const failures = settled.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    try {
      await dropDatabase(databaseName);
    } catch (error: unknown) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'Connections fixture cleanup failed');
  });

  const unavailable = (resource: string): never => {
    throw new Error(
      `${resource} fixture is not available outside its lifetime`,
    );
  };
  return Object.freeze({
    get api() {
      return api ?? unavailable('API connection');
    },
    get worker() {
      return worker ?? unavailable('Worker connection');
    },
    get destinations() {
      return destinations ?? unavailable('Notification destination');
    },
  });
}

export {
  CONNECTION_AUTH_TYPE,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionNotFoundError,
  ConnectionSecretVersionConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
  FailureNotificationDestinationError,
  Pool,
  canonicalOutboxPayloadChecksum,
  checkDatabaseReadiness,
  createFailureNotificationStore,
  createHash,
  parseDatabaseConfig,
  randomUUID,
};
