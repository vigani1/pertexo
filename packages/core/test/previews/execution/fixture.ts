import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import {
  parseDatabaseConfig,
  createWorkspaceDatabase,
} from '@pertexo/database/platform';
import {
  migrateDatabase,
  createDisposableDatabaseFixture,
} from '@pertexo/database/testing';
import type { acceptPreviewRun } from '../../../src/previews/runs/acceptance.repository.js';

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

const databaseName = `pertexo_test_preview_${randomUUID().replaceAll('-', '')}`;

export const disposableDatabase = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName,
  ownerRole: 'pertexo_owner',
});

const migrationUrl = disposableDatabase.databaseUrl(migrationBaseUrl);

const apiUrl = disposableDatabase.databaseUrl(apiBaseUrl);

const workerUrl = disposableDatabase.databaseUrl(workerBaseUrl);

export const workspaceA = randomUUID();

export const workspaceB = randomUUID();

export const actorId = randomUUID();

export const workflowA = randomUUID();

export const workflowB = randomUUID();

export const workflowC = randomUUID();

export const keyHash = digest('preview-key');

export const requestHash = digest('preview-request');

export const otherRequestHash = digest('preview-request-conflict');

export let apiDatabase!: ReturnType<typeof createWorkspaceDatabase>;

export let workerDatabase!: ReturnType<typeof createWorkspaceDatabase>;

let databaseCreated = false;

const migrationConfig = {
  appRole: 'pertexo_app',
  connectionString: migrationUrl,
  maintenanceRole: 'pertexo_maintenance',
  ownerRole: 'pertexo_owner',
} as const;

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function input(
  overrides: Partial<Parameters<typeof acceptPreviewRun>[1]> = {},
) {
  const now = Date.now();
  const expiresAt = overrides.expiresAt ?? new Date(now + 60 * 60 * 1_000);
  const executionDeadlineAt =
    overrides.executionDeadlineAt ??
    new Date(Math.min(now + 5 * 60 * 1_000, expiresAt.getTime()));
  return {
    actorUserId: actorId,
    definitionKey: 'http.request',
    definitionVersion: 1,
    draftFingerprint: digest('draft-revision-1'),
    draftRevision: 1,
    dryRun: 'not_supported',
    executableNode: {
      id: 'http',
      config: { url: 'https://provider.example.test/resource' },
      connectionRefs: {},
    },
    executorKey: 'http.request',
    executorVersion: 1,
    executionDeadlineAt,
    expiresAt,
    input: { kind: 'manual', value: { customerId: 'customer-1' } },
    keyHash,
    mayContactProvider: true,
    mayCauseExternalSideEffect: true,
    nodeId: 'http',
    operation: 'preview.execute',
    requestHash,
    requestId: 'request-preview-1',
    scope: `${actorId}:${workflowA}`,
    sideEffectClass: 'unsafe',
    traceId: 'trace-preview-1',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    workflowId: workflowA,
    ...overrides,
  } as const;
}

export async function ownerWorkspaceQuery(
  workspaceId: string,
  text: string,
  values: unknown[] = [],
): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    await client.query(text, values);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export function hasPostgresCode(error: unknown, code: string): boolean {
  let current = error;
  while (typeof current === 'object' && current !== null) {
    if ('code' in current && current.code === code) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

export async function resetFixture(): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(`truncate table
       app.preview_attempts, app.preview_runs, app.idempotency_records,
       app.outbox_events, app.audit_events, app.workflow_drafts,
       app.workflow_versions, app.workflows, app.workspace_memberships,
       app.workspaces, app.users
     cascade`);
    await client.query(
      `insert into app.users (id, email, display_name, status)
       values ($1, $2, 'Preview actor', 'active')`,
      [actorId, `preview-${actorId}@example.test`],
    );
    await client.query(
      `insert into app.workspaces (id, name, slug, status, created_by)
       values
         ($1, 'Preview A', $2, 'active', $5),
         ($3, 'Preview B', $4, 'active', $5)`,
      [
        workspaceA,
        `preview-a-${workspaceA}`,
        workspaceB,
        `preview-b-${workspaceB}`,
        actorId,
      ],
    );
    for (const workspaceId of [workspaceA, workspaceB]) {
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.workspace_memberships
         (workspace_id, user_id, role, status)
         values ($1, $2, 'builder', 'active')`,
        [workspaceId, actorId],
      );
    }
    for (const [workspaceId, workflowId, workflowName] of [
      [workspaceA, workflowA, 'Workflow A'],
      [workspaceA, workflowC, 'Workflow C'],
      [workspaceB, workflowB, 'Workflow B'],
    ] as const) {
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.workflows
       (id, workspace_id, name, created_by)
       values ($1, $2, $3, $4)`,
        [workflowId, workspaceId, workflowName, actorId],
      );
      await client.query(
        `insert into app.workflow_drafts
       (workflow_id, workspace_id, revision, graph_json, updated_by)
       values ($1, $2, 1, '{"nodes":[],"edges":[],"settings":{}}', $3)`,
        [workflowId, workspaceId, actorId],
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

export async function beforeAllFixture1() {
  await disposableDatabase.create();
  databaseCreated = true;
  try {
    await migrateDatabase(migrationConfig);
    apiDatabase = createWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
    );
    workerDatabase = createWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: workerUrl, max: 2 }),
    );
  } catch (error: unknown) {
    await Promise.allSettled([apiDatabase.close(), workerDatabase.close()]);
    await disposableDatabase.drop();
    databaseCreated = false;
    throw error;
  }
}

export async function afterAllFixture2() {
  const failures: unknown[] = [];
  for (const close of [
    () => apiDatabase.close(),
    () => workerDatabase.close(),
  ]) {
    try {
      await close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (databaseCreated) {
    try {
      await disposableDatabase.drop();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Preview fixture cleanup failed');
}
