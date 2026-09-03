import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import type { DatabaseError } from 'pg';
import { afterAll, beforeAll } from 'vitest';

import {
  CONNECTION_AUTH_TYPE,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionSecretVersionConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
  createConnectionDatabase,
  type ConnectionDatabase,
  type CreateConnectionInput,
} from '../../src/connections/connections.js';
import {
  createFailureNotificationDestinationDatabase,
  FailureNotificationDestinationError,
  type FailureNotificationDestinationDatabase,
} from '../../src/execution/failure-notification-destinations.js';
import { createFailureNotificationStore } from '../../src/execution/failure-notifications.js';
import { parseDatabaseConfig } from '../../src/config.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../../src/migrations.js';
import { canonicalOutboxPayloadChecksum } from '../../src/execution/outbox.js';
import { dropDisconnectedDatabase } from './disposable-database.js';
import { checkDatabaseReadiness } from '../../src/platform/readiness.js';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
export const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
export const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
export const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
export const databaseName = `pertexo_test_connections_${randomUUID().replaceAll('-', '')}`;
export const upgradeDatabaseName = `pertexo_test_connections_upgrade_${randomUUID().replaceAll('-', '')}`;
export const priorDatabaseName = `pertexo_test_connections_prior_${randomUUID().replaceAll('-', '')}`;
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

export let api: ConnectionDatabase;
export let worker: ConnectionDatabase;
export let destinations: FailureNotificationDestinationDatabase;
export let closeResources = (): Promise<void> => Promise.resolve();
export let upgradeApplied: readonly string[] = [];
export let priorApplied: readonly string[] = [];

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
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.query(`create database "${name}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${name}" from public`);
    await admin.query(
      `grant connect on database "${name}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
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
    apiRuntimeRole: 'pertexo_api',
    connectionString: databaseUrl(migrationBaseUrl, name),
    dispatcherRole: 'pertexo_dispatcher',
    maintenanceRole: 'pertexo_maintenance',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    operatorRole: 'pertexo_operator',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  } as const;
}

export async function migrateBefore(
  name: string,
  boundary: string,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-prior-'));
  try {
    const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
      (migration) => /^\d{4}_.+\.sql$/u.test(migration) && migration < boundary,
    );
    await Promise.all(
      migrations.map((migration) =>
        copyFile(
          path.join(MIGRATIONS_DIRECTORY, migration),
          path.join(directory, migration),
        ),
      ),
    );
    await migrateDatabase(migrationConfig(name), directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function seedWorkspaces(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
  const client = await pool.connect();
  try {
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
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function seedPriorNotificationRows(): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl(migrationBaseUrl, priorDatabaseName),
  });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(
      'alter table app.workflow_runs no force row level security',
    );
    await client.query(
      'alter table app.run_failure_notification_intents no force row level security',
    );
    await client.query(
      `insert into app.users (id,email,display_name,status)
       values ($1,$2,'Historical notification owner','active')`,
      [historicalOwnerId, `historical-${historicalOwnerId}@example.test`],
    );
    await client.query(
      `insert into app.workspaces (id,name,slug,status,created_by)
       values ($1,'Historical notifications',$2,'active',$3)`,
      [
        historicalWorkspaceId,
        `historical-${historicalWorkspaceId.slice(0, 8)}`,
        historicalOwnerId,
      ],
    );
    await client.query("select set_config('app.workspace_id',$1,true)", [
      historicalWorkspaceId,
    ]);
    await client.query(
      `insert into app.workflow_runs (
         id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
         failure_notification_policy_version,failure_notification_destination_id,
         failure_notification_destination_config_version,
         failure_notification_side_effect_class
       ) values ($1,$2,$3,$4,'manual','failed',1,$5,7,'safe')`,
      [
        historicalRunId,
        historicalWorkspaceId,
        randomUUID(),
        randomUUID(),
        historicalDestinationId,
      ],
    );
    for (const [intentId, sequence, status] of [
      [historicalIntentId, 1, 'pending'],
      [historicalRetryIntentId, 2, 'retry'],
      [historicalDispatchingIntentId, 3, 'dispatching'],
    ] as const) {
      await client.query(
        `insert into app.run_failure_notification_intents (
           id,workspace_id,workflow_run_id,terminal_event_sequence,policy_version,
           destination_id,destination_config_version,side_effect_class,context,
           context_checksum,status,delivery_attempts,dispatch_marked_at,recovery_at,
           next_delivery_at
         ) values ($1,$2,$3,$4,1,$5,7,'safe','{}'::jsonb,$6,$7::varchar,
           case when $7::text='pending' then 0 else 1 end,
           case when $7::text='dispatching' then clock_timestamp() end,
           case when $7::text='dispatching' then clock_timestamp()+interval '1 minute' end,
           case when $7::text='retry' then clock_timestamp() end)`,
        [
          intentId,
          historicalWorkspaceId,
          historicalRunId,
          sequence,
          historicalDestinationId,
          'a'.repeat(64),
          status,
        ],
      );
      const outboxEventId = historicalOutboxByIntent.get(intentId);
      if (outboxEventId === undefined)
        throw new Error('Historical outbox fixture is incomplete');
      const payload = {
        schemaVersion: 1 as const,
        workspaceId: historicalWorkspaceId,
        notificationIntentId: intentId,
        outboxEventId,
      };
      await client.query(
        `insert into app.outbox_events (
           id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
           payload,payload_checksum
         ) values ($1,$2,'deliver-run-failure-notification',1,
           'run-failure-notification',$3,$4::jsonb,$5)`,
        [
          outboxEventId,
          historicalWorkspaceId,
          intentId,
          JSON.stringify(payload),
          canonicalOutboxPayloadChecksum(payload),
        ],
      );
    }
    await client.query(
      'alter table app.workflow_runs force row level security',
    );
    await client.query(
      'alter table app.run_failure_notification_intents force row level security',
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
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
  const connectionId = overrides.connectionId ?? randomUUID();
  const secretVersionId = overrides.secretVersionId ?? randomUUID();
  const name = overrides.name ?? `HTTP ${connectionId.slice(0, 8)}`;
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

beforeAll(async () => {
  await Promise.all([
    createDatabase(databaseName),
    createDatabase(upgradeDatabaseName),
    createDatabase(priorDatabaseName),
  ]);
  await migrateDatabase(migrationConfig());
  await migrateBefore(upgradeDatabaseName, '0021_');
  upgradeApplied = await migrateDatabase(migrationConfig(upgradeDatabaseName));
  await migrateBefore(priorDatabaseName, '0037_');
  await seedPriorNotificationRows();
  priorApplied = await migrateDatabase(migrationConfig(priorDatabaseName));
  await seedWorkspaces();
  api = createConnectionDatabase(
    parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl), max: 4 }),
  );
  worker = createConnectionDatabase(
    parseDatabaseConfig({
      connectionString: databaseUrl(workerBaseUrl),
      max: 4,
    }),
  );
  destinations = createFailureNotificationDestinationDatabase(
    parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl), max: 4 }),
  );
  closeResources = async (): Promise<void> => {
    await Promise.allSettled([
      api.close(),
      worker.close(),
      destinations.close(),
    ]);
  };
});

afterAll(async () => {
  await closeResources();
  await Promise.all([
    dropDatabase(databaseName),
    dropDatabase(upgradeDatabaseName),
    dropDatabase(priorDatabaseName),
  ]);
});

export {
  CONNECTION_AUTH_TYPE,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
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
