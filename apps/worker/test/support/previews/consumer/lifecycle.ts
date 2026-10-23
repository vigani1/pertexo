import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { dropDisconnectedDatabase } from '../../infrastructure/disposable-database.js';

import {
  migrateDatabase,
  parseMigrationConfig,
} from '@pertexo/database/testing';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import { Queue } from 'bullmq';
import { QUEUE_NAME } from '@pertexo/queue';
import {
  workerTransportIntegrationEnabled,
  adminUrl,
  migrationUrl,
  apiUrl,
  workerUrl,
  redisNamespace,
  databaseName,
  workspaceId,
  actorUserId,
  workflowId,
  workflowVersionId,
  validateWorkflowGraph,
  databaseUrl,
  redisConnectionOptions,
} from './environment.js';

export let apiPool: Pool;

export let workerPool: Pool;

let ownerPool: Pool;

let databaseCreated = false;

export async function withOwner<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function clearNodeAttemptQueue(): Promise<void> {
  const queue = new Queue(QUEUE_NAME.nodeAttempts, {
    connection: redisConnectionOptions(),
  });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
}

async function seedIdentity(): Promise<void> {
  await withOwner(async (client) => {
    await client.query(`
      create table app.preview_process_provider_effects (
        workspace_id uuid not null references app.workspaces(id) on delete cascade,
        effect_key varchar(200) not null,
        invocation_count integer not null check (invocation_count > 0),
        primary key (workspace_id,effect_key)
      );
      alter table app.preview_process_provider_effects enable row level security;
      alter table app.preview_process_provider_effects force row level security;
      create policy preview_process_provider_effects_workspace
        on app.preview_process_provider_effects
        using (workspace_id::text =
          nullif(current_setting('app.workspace_id', true), ''))
        with check (workspace_id::text =
          nullif(current_setting('app.workspace_id', true), ''));
      revoke all on app.preview_process_provider_effects from public;
      grant select,insert,update on app.preview_process_provider_effects
        to pertexo_app;
    `);
    await client.query(
      `insert into app.users (id, email, display_name, status)
       values ($1, $2, $3, 'active')`,
      [actorUserId, 'preview-transport@example.test', 'Preview Transport'],
    );
    await client.query(
      `insert into app.workspaces (id, name, slug, status, created_by)
       values ($1, $2, $3, 'active', $4)`,
      [
        workspaceId,
        'Preview Transport',
        `preview-transport-${randomUUID().slice(0, 8)}`,
        actorUserId,
      ],
    );
    // Forced RLS applies to the owner too; tenant-scoped inserts need
    // transaction-local context.
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    await client.query(
      `insert into app.workspace_memberships
         (workspace_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [workspaceId, actorUserId],
    );
    await client.query(
      `insert into app.workflows (id, workspace_id, name, lifecycle_status,
         activation_status, created_by)
       values ($1, $2, $3, 'active', 'inactive', $4)`,
      [workflowId, workspaceId, 'Preview transport target', actorUserId],
    );
    await client.query(
      `insert into app.workflow_drafts
         (workflow_id, workspace_id, revision, graph_json,
          updated_by)
       values ($1, $2, 3, $3::jsonb, $4)`,
      [
        workflowId,
        workspaceId,
        '{"nodes":[],"edges":[],"settings":{}}',
        actorUserId,
      ],
    );
    const executable = buildWorkflowExecutable({
      graph: validateWorkflowGraph,
      catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
    });
    await client.query(
      `insert into app.workflow_versions (
         id, workspace_id, workflow_id, version_number,
         graph_json, checksum, executable_json,
         published_by
       ) values ($1, $2, $3, 1, $4::jsonb, $5, $6::jsonb, $7)`,
      [
        workflowVersionId,
        workspaceId,
        workflowId,
        JSON.stringify(validateWorkflowGraph),
        executable.checksum,
        JSON.stringify(executable.envelope),
        actorUserId,
      ],
    );
  });
}

let redisNamespaceAcquired = false;

let fixtureCleanupPromise: Promise<void> | undefined;

function cleanupPreviewIntegrationFixture(): Promise<void> {
  fixtureCleanupPromise ??= (async () => {
    const cleanupErrors: unknown[] = [];
    const attempt = async (
      label: string,
      operation: () => unknown,
    ): Promise<void> => {
      await Promise.resolve()
        .then(operation)
        .catch((cause: unknown) => {
          cleanupErrors.push(
            new Error(`Preview integration cleanup failed: ${label}`, {
              cause,
            }),
          );
        });
    };
    if (redisNamespaceAcquired)
      await attempt('clear node-attempt queue', clearNodeAttemptQueue);
    await attempt('close API pool', () => apiPool.end());
    await attempt('close worker pool', () => workerPool.end());
    await attempt('close owner pool', () => ownerPool.end());
    if (redisNamespaceAcquired) {
      await attempt('catalog Redis namespace', () => redisNamespace.close());
      redisNamespaceAcquired = false;
    }
    if (databaseCreated) {
      const admin = new Pool({ connectionString: adminUrl, max: 1 });
      await attempt('drop disposable database', async () => {
        await dropDisconnectedDatabase(admin, databaseName);
        databaseCreated = false;
      });
      await attempt('close cleanup admin pool', () => admin.end());
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        cleanupErrors,
        'Preview integration cleanup failed',
      );
  })();
  return fixtureCleanupPromise;
}

beforeAll(async () => {
  if (!workerTransportIntegrationEnabled) return;
  try {
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    let setupError: unknown;
    try {
      await admin.query(
        `create database "${databaseName}" owner pertexo_owner`,
      );
      databaseCreated = true;
      await admin.query(`revoke all on database "${databaseName}" from public`);
      await admin.query(
        `grant connect on database "${databaseName}" to pertexo_migration, pertexo_app, pertexo_app, pertexo_maintenance, pertexo_maintenance`,
      );
    } catch (error: unknown) {
      setupError = error;
    }
    await admin.end().catch((error: unknown) => {
      setupError =
        setupError === undefined
          ? error
          : new AggregateError(
              [setupError, error],
              'Preview integration database setup failed',
            );
    });
    if (setupError !== undefined)
      throw setupError instanceof Error
        ? setupError
        : new Error('Preview integration database setup failed', {
            cause: setupError,
          });
    await redisNamespace.acquire();
    redisNamespaceAcquired = true;
    await migrateDatabase(
      parseMigrationConfig({
        ...process.env,
        DATABASE_MIGRATION_URL: databaseUrl(migrationUrl),
        NODE_ENV: 'test',
      }),
    );
    apiPool = new Pool({ connectionString: databaseUrl(apiUrl), max: 4 });
    workerPool = new Pool({
      connectionString: databaseUrl(workerUrl),
      max: 4,
    });
    ownerPool = new Pool({
      connectionString: databaseUrl(migrationUrl),
      max: 1,
    });
    await seedIdentity();
    await clearNodeAttemptQueue();
  } catch (setupError: unknown) {
    let cleanupError: unknown;
    await cleanupPreviewIntegrationFixture().catch((error: unknown) => {
      cleanupError = error;
    });
    if (cleanupError === undefined) throw setupError;
    throw new AggregateError(
      [setupError, cleanupError],
      'Preview integration fixture setup failed',
    );
  }
}, 60_000);

afterAll(async () => {
  if (!workerTransportIntegrationEnabled) return;
  await cleanupPreviewIntegrationFixture();
});
