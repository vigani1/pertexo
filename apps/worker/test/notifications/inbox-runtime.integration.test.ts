import { randomUUID } from 'node:crypto';

import { createWorkspaceInboxFoldStore } from '@pertexo/database/inbox';
import {
  createIdentityWorkspaceDatabase,
  migrateDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import {
  RedisWorkspaceInboxHintPublisher,
  parseWorkspaceInboxHint,
  workspaceInboxChannel,
} from '@pertexo/queue';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createWorkspaceInboxRuntime } from '../../src/notifications/inbox-runtime.js';
import { dropDisconnectedDatabase } from '../support/infrastructure/disposable-database.js';

const databaseName = `pertexo_test_inbox_runtime_${randomUUID().replaceAll('-', '')}`;
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

let admin: Pool;

beforeAll(async () => {
  const server = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await server.query(`create database "${databaseName}" owner pertexo_owner`);
    await server.query(`revoke all on database "${databaseName}" from public`);
    await server.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_app, pertexo_app`,
    );
  } finally {
    await server.end();
  }
  await migrateDatabase({
    appRole: 'pertexo_app',
    connectionString: databaseUrl(migrationBaseUrl),
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  });
  admin = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
}, 60_000);

afterAll(async () => {
  await admin.end();
  const server = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(server, databaseName);
  } finally {
    await server.end();
  }
}, 30_000);

/** A workspace with one workflow and one terminal failure pending fold. */
async function recordFailure() {
  const identity = createIdentityWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl), max: 1 }),
  );
  const workflowId = randomUUID();
  const runId = randomUUID();
  let workspaceId: string;
  try {
    const owner = await identity.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Owner',
    });
    workspaceId = (
      await identity.createWorkspaceWithOwner({
        name: 'Inbox runtime',
        slug: `inbox-runtime-${randomUUID().slice(0, 8)}`,
        ownerUserId: owner.id,
      })
    ).id;
    await admin.query(
      'insert into app.workflows (id,workspace_id,name,created_by) values ($1,$2,$3,$4)',
      [workflowId, workspaceId, 'Nightly import', owner.id],
    );
    await admin.query(
      `insert into app.workspace_execution_entitlement_versions
         (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
       values ($1,2,'active',10,100,'-infinity'::timestamptz)`,
      [workspaceId],
    );
    await admin.query(
      'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
      [workspaceId],
    );
    await admin.query(
      `with tenant as (select set_config('app.workspace_id',$2::uuid::text,true))
       insert into app.workflow_runs (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
       select $1::uuid,$2::uuid,$3::uuid,$4::uuid,'manual','failed' from tenant`,
      [runId, workspaceId, workflowId, randomUUID()],
    );
  } finally {
    await identity.close();
  }
  // The coordinator's producer writes exactly this row as the worker role.
  const worker = new Pool({
    connectionString: databaseUrl(workerBaseUrl),
    max: 1,
  });
  const client = await worker.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await client.query(
      `insert into app.workspace_inbox_events
         (id,workspace_id,workflow_id,run_id,terminal_event_sequence,kind,occurred_at)
       values ($1,$2,$3,$4,3,'failed',clock_timestamp())`,
      [randomUUID(), workspaceId, workflowId, runId],
    );
    await client.query('commit');
  } finally {
    client.release();
    await worker.end();
  }
  return { workspaceId, workflowId, runId };
}

it('folds a pending failure into its thread and hints the workspace', async () => {
  const { workspaceId, workflowId, runId } = await recordFailure();
  const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const hints: string[] = [];
  subscriber.on('message', (_channel: string, message: string) => {
    hints.push(message);
  });
  await subscriber.subscribe(workspaceInboxChannel(workspaceId));
  const diagnostics = { cycleFailed: vi.fn(), hintFailed: vi.fn() };
  const runtime = createWorkspaceInboxRuntime(
    createWorkspaceInboxFoldStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 2,
      }),
    ),
    new RedisWorkspaceInboxHintPublisher({ redisUrl }),
    { foldBatchSize: 100, foldPollMillis: 100 },
    diagnostics,
  );
  try {
    runtime.start();
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(hints).toHaveLength(1);
    });
    const [thread] = (
      await admin.query<{
        workflow_id: string;
        occurrence_count: string;
        latest_run_id: string;
        revision: string;
      }>(
        `select workflow_id,occurrence_count::text,latest_run_id,revision::text
           from app.workspace_inbox_threads where workspace_id=$1`,
        [workspaceId],
      )
    ).rows;
    expect(thread).toMatchObject({
      workflow_id: workflowId,
      occurrence_count: '1',
      latest_run_id: runId,
    });
    expect(parseWorkspaceInboxHint(hints[0] ?? '')).toEqual({
      kind: 'changed',
      revision: thread?.revision,
    });
    const pending = await admin.query(
      'select 1 from app.workspace_inbox_events where workspace_id=$1',
      [workspaceId],
    );
    expect(pending.rowCount).toBe(0);
    expect(diagnostics.cycleFailed).not.toHaveBeenCalled();
    expect(diagnostics.hintFailed).not.toHaveBeenCalled();
  } finally {
    await runtime.close();
    subscriber.disconnect();
  }
});
