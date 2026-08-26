import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const lifecycleBaseUrl =
  process.env.DATABASE_LIFECYCLE_COMMAND_URL ??
  'postgresql://pertexo_lifecycle_command:pertexo-local-lifecycle-command@localhost:5432/pertexo';
const databaseName = `pertexo_test_lifecycle_intents_${randomUUID().replaceAll('-', '')}`;
const withDatabase = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};
const migrationUrl = withDatabase(migrationBaseUrl);
const apiUrl = withDatabase(apiBaseUrl);
const lifecycleUrl = withDatabase(lifecycleBaseUrl);
const workspaceId = randomUUID();
const ownerUserId = randomUUID();
const otherUserId = randomUUID();
let api: Pool | undefined;
let lifecycle: Pool | undefined;

async function apiWorkspaceQuery(
  text: string,
  values: readonly unknown[],
  actorUserId = ownerUserId,
) {
  if (api === undefined) throw new Error('API pool unavailable');
  const client = await api.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await client.query("select set_config('app.actor_id',$1,true)", [
      actorUserId,
    ]);
    const result = await client.query(text, [...values]);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,
       pertexo_api,pertexo_worker,pertexo_dispatcher,pertexo_maintenance,
       pertexo_lifecycle_command`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    apiRuntimeRole: 'pertexo_api',
    connectionString: migrationUrl,
    dispatcherRole: 'pertexo_dispatcher',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  });
  const owner = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await owner.query('begin');
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await owner.query(
      `insert into app.users(id,email,display_name) values
       ($1,$2,'Owner'),($3,$4,'Other')`,
      [
        ownerUserId,
        `${ownerUserId}@example.test`,
        otherUserId,
        `${otherUserId}@example.test`,
      ],
    );
    await owner.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Intent fixture',$2,$3)",
      [workspaceId, `intent-${workspaceId}`, ownerUserId],
    );
    await owner.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'owner')",
      [workspaceId, ownerUserId],
    );
    await owner.query('commit');
  } catch (error: unknown) {
    await owner.query('rollback');
    throw error;
  } finally {
    await owner.end();
  }
  api = new Pool({ connectionString: apiUrl, max: 2 });
  lifecycle = new Pool({ connectionString: lifecycleUrl, max: 2 });
}, 120_000);

afterAll(async () => {
  await Promise.all([api?.end(), lifecycle?.end()]);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('workspace lifecycle command intents', () => {
  it('creates one exact durable operation without changing workspace state', async () => {
    if (api === undefined) throw new Error('API pool unavailable');
    const operationId = randomUUID();
    const values = [
      operationId,
      workspaceId,
      'f'.repeat(64),
      'deletion_requested',
      ownerUserId,
      'Delete workspace',
      'a'.repeat(64),
    ];
    const first = await apiWorkspaceQuery(
      'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
      values,
    );
    const replay = await apiWorkspaceQuery(
      'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), ...values.slice(1)],
    );

    expect(first.rows[0]).toMatchObject({
      command_type: 'deletion_requested',
      operation_id: operationId,
      status: 'pending',
      workspace_id: workspaceId,
    });
    expect(replay.rows[0]).toMatchObject({ operation_id: operationId });
    await expect(
      apiWorkspaceQuery(
        'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          workspaceId,
          'f'.repeat(64),
          'deletion_requested',
          ownerUserId,
          'Changed',
          'b'.repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      api.query('select * from app.workspace_lifecycle_operations'),
    ).rejects.toMatchObject({
      code: '42501',
    });
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('set role pertexo_owner');
      const state = await owner.query<{ status: string }>(
        'select status from app.workspaces where id=$1',
        [workspaceId],
      );
      expect(state.rows[0]?.status).toBe('active');
    } finally {
      await owner.end();
    }
  });

  it('rechecks owner authorization and exposes only narrow role functions', async () => {
    if (api === undefined || lifecycle === undefined)
      throw new Error('Lifecycle pools unavailable');
    await expect(
      api.query(
        'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          workspaceId,
          '1'.repeat(64),
          'deletion_requested',
          ownerUserId,
          'No context',
          'e'.repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      apiWorkspaceQuery(
        'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          workspaceId,
          '2'.repeat(64),
          'deletion_requested',
          otherUserId,
          'Forged',
          'c'.repeat(64),
        ],
        otherUserId,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      api.query(
        "select * from app.claim_workspace_lifecycle_operations('api',1,interval '1 minute')",
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      lifecycle.query(
        'select * from app.request_workspace_lifecycle_operation($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          workspaceId,
          '3'.repeat(64),
          'deletion_requested',
          ownerUserId,
          'Forged',
          'd'.repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      lifecycle.query(
        "select app.project_workspace_lifecycle_command(null,null,null,'purge_started',null,null,null,null,null,null,null)",
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('claims with monotonic fencing and rejects a stale release', async () => {
    if (lifecycle === undefined) throw new Error('Lifecycle pool unavailable');
    const first = await lifecycle.query<{
      lease_fence: string;
      lease_token: string;
      operation_id: string;
    }>(
      "select * from app.claim_workspace_lifecycle_operations('command:test',1,interval '10 milliseconds')",
    );
    expect(typeof first.rows[0]?.operation_id).toBe('string');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await lifecycle.query<{
      lease_fence: string;
      lease_token: string;
      operation_id: string;
    }>(
      "select * from app.claim_workspace_lifecycle_operations('command:test-2',1,interval '1 minute')",
    );
    expect(Number(second.rows[0]?.lease_fence)).toBe(
      Number(first.rows[0]?.lease_fence) + 1,
    );
    const stale = await lifecycle.query<{ released: boolean }>(
      'select app.release_workspace_lifecycle_operation($1,$2,$3) released',
      [
        first.rows[0]?.operation_id,
        first.rows[0]?.lease_token,
        first.rows[0]?.lease_fence,
      ],
    );
    expect(stale.rows[0]?.released).toBe(false);
    const released = await lifecycle.query<{ released: boolean }>(
      'select app.release_workspace_lifecycle_operation($1,$2,$3) released',
      [
        second.rows[0]?.operation_id,
        second.rows[0]?.lease_token,
        second.rows[0]?.lease_fence,
      ],
    );
    expect(released.rows[0]?.released).toBe(true);
  });
});
