import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { IdempotencyRequestConflictError } from '../src/execution-acceptance.js';
import { migrateDatabase } from '../src/migrations.js';
import {
  createWorkflowRunDatabase,
  WorkflowRunNotExecutableError,
} from '../src/workflow-run-api.js';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const actorId = randomUUID();
const workflowId = randomUUID();
const workflowVersionId = randomUUID();
const owner = new Pool({ connectionString: migrationUrl, max: 1 });
const api = new Pool({ connectionString: apiUrl, max: 1 });
const database = createWorkflowRunDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
);
const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function checkpoint() {
  return {
    schemaVersion: 1,
    engineVersion: 'phase3-engine-v1',
    workflowVersionId,
    revision: 0,
    runStatus: 'queued',
    nextEventSequence: 2,
    readySet: [],
    admittedInvocationKeys: [],
    invocations: [],
    joins: [],
    loops: [],
    remainingIterationBudget: 1_000,
    cancelRequested: false,
    deadlineExpired: false,
  } as const;
}

function startInput(
  requestHash = digest('request-1'),
  idempotencyKeyHash = digest('key-1'),
) {
  return {
    actorId,
    workspaceId,
    workflowId,
    idempotencyKeyHash,
    requestHash,
    scope: `workflow:${workflowId}:manual`,
    input: { customerId: 'customer-42' },
    requestId: 'request-42',
    traceId: 'trace-42',
    checkpointFactory: (projection: Readonly<{ id: string }>) => {
      expect(projection.id).toBe(workflowVersionId);
      return { engineVersion: 'phase3-engine-v1', checkpoint: checkpoint() };
    },
  } as const;
}

async function ownerQuery(text: string, values: readonly unknown[] = []) {
  const client = await owner.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
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

async function apiQuery(text: string, values: readonly unknown[] = []) {
  const client = await api.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
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

async function resetFixture(): Promise<void> {
  await ownerQuery(`
    truncate table
      app.audit_events,
      app.idempotency_records,
      app.run_events,
      app.run_checkpoints,
      app.node_attempts,
      app.node_runs,
      app.workflow_runs,
      app.outbox_events,
      app.workflow_versions,
      app.workflow_drafts,
      app.workflows,
      app.workspace_memberships,
      app.workspaces,
      app.users
    cascade
  `);
  await ownerQuery(
    `insert into app.users (id, email, display_name, status)
     values ($1, $2, 'Run API actor', 'active')`,
    [actorId, `run-api-${actorId}@example.test`],
  );
  await ownerQuery(
    `insert into app.workspaces (id, name, slug, status, created_by)
     values
       ($1, 'Run API', $3, 'active', $5),
       ($2, 'Other Run API', $4, 'active', $5)`,
    [
      workspaceId,
      otherWorkspaceId,
      `run-api-${workspaceId}`,
      `run-api-other-${otherWorkspaceId}`,
      actorId,
    ],
  );
  await ownerQuery(
    `insert into app.workflows
       (id, workspace_id, name, lifecycle_status, activation_status,
        created_by)
     values ($1, $2, 'Executable Run API', 'active', 'inactive', $3)`,
    [workflowId, workspaceId, actorId],
  );
  await ownerQuery(
    `insert into app.workflow_versions
       (id, workspace_id, workflow_id, version_number, schema_version,
        graph_json, checksum, executable_schema_version, executable_json,
        compatibility_release_epoch, published_by)
     values
       ($1, $2, $3, 1, 1, $4::jsonb, $5, 2, $6::jsonb, 1, $7)`,
    [
      workflowVersionId,
      workspaceId,
      workflowId,
      JSON.stringify({ edges: [], nodes: [], schemaVersion: 1, settings: {} }),
      `wf:v2:sha256:${'a'.repeat(64)}`,
      JSON.stringify({ schemaVersion: 2, marker: 'run-api' }),
      actorId,
    ],
  );
  await ownerQuery(
    `update app.workflows set published_version_id = $2 where id = $1`,
    [workflowId, workflowVersionId],
  );
}

beforeAll(async () => {
  await migrateDatabase(migrationConfig);
});

beforeEach(resetFixture);

afterAll(async () => {
  await database.close();
  await api.end();
  await owner.end();
});

describe('workflow run API persistence', () => {
  it('atomically starts, exactly replays, reads, and cancels one published V2 run', async () => {
    const first = await database.start(startInput());
    expect(first.replayed).toBe(false);
    expect(first.run).toMatchObject({
      workflowId,
      workflowVersionId,
      status: 'queued',
    });

    await ownerQuery(
      `update app.workflows set published_version_id = null where id = $1`,
      [workflowId],
    );
    const replay = await database.start(startInput());
    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      database.start(startInput(digest('different-request'))),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);

    await expect(
      database.get({ workspaceId: otherWorkspaceId, runId: first.run.id }),
    ).resolves.toBeUndefined();
    await expect(
      database.get({ workspaceId, runId: first.run.id }),
    ).resolves.toMatchObject({ run: { id: first.run.id }, nodes: [] });

    const canceled = await database.cancel({
      actorId,
      workspaceId,
      runId: first.run.id,
      reason: 'operator request',
      requestId: 'request-cancel-42',
    });
    expect(canceled.alreadyRequested).toBe(false);
    expect(canceled.run.cancelRequestedAt).toBeInstanceOf(Date);
    await expect(
      database.cancel({
        actorId,
        workspaceId,
        runId: first.run.id,
        reason: 'operator request',
        requestId: 'request-cancel-42',
      }),
    ).resolves.toMatchObject({ alreadyRequested: true });

    const effects = await apiQuery(
      `select
         (select count(*)::int from app.workflow_runs) runs,
         (select count(*)::int from app.run_checkpoints) checkpoints,
         (select count(*)::int from app.run_events) events,
         (select count(*)::int from app.outbox_events) outbox,
         (select count(*)::int from app.audit_events) audits`,
    );
    expect(effects.rows).toEqual([
      { runs: 1, checkpoints: 1, events: 2, outbox: 2, audits: 2 },
    ]);
  });

  it('rejects a new start when the workflow has no executable publication', async () => {
    await ownerQuery(
      `update app.workflows set published_version_id = null where id = $1`,
      [workflowId],
    );
    await expect(database.start(startInput())).rejects.toBeInstanceOf(
      WorkflowRunNotExecutableError,
    );
  });
});
