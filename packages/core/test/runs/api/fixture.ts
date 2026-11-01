import { createHash, randomUUID } from 'node:crypto';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { expect } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';

import {
  migrateDatabase,
  createDisposableDatabaseFixture,
} from '@pertexo/database/testing';
import { createWorkflowRunDatabase } from '../../../src/runs/runs.repository.js';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const maintenanceBaseUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

const databaseName = `pertexo_test_run_api_${randomUUID().replaceAll('-', '')}`;

export const disposableDatabase = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName,
  ownerRole: 'pertexo_owner',
});

export const migrationUrl = disposableDatabase.databaseUrl(migrationBaseUrl);

const apiUrl = disposableDatabase.databaseUrl(apiBaseUrl);

export const maintenanceUrl =
  disposableDatabase.databaseUrl(maintenanceBaseUrl);

export const workspaceId = randomUUID();

export const otherWorkspaceId = randomUUID();

export const actorId = randomUUID();

export const workflowId = randomUUID();

export const workflowVersionId = randomUUID();

export const retainedWorkflowVersionId = randomUUID();

export const otherWorkflowId = randomUUID();

export const otherWorkflowVersionId = randomUUID();

export const owner = new Pool({ connectionString: migrationUrl, max: 1 });

export const api = new Pool({ connectionString: apiUrl, max: 1 });

export const database = createWorkflowRunDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
);

const migrationConfig = {
  appRole: 'pertexo_app',
  connectionString: migrationUrl,
  maintenanceRole: 'pertexo_maintenance',
  ownerRole: 'pertexo_owner',
} as const;

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function checkpoint(versionId: string = workflowVersionId) {
  return {
    workflowVersionId: versionId,
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
    branchSelections: [],
  } as const;
}

export function startInput(
  requestHash = digest('request-1'),
  idempotencyKeyHash = digest('key-1'),
  options: Readonly<{
    workspaceId?: string;
    workflowId?: string;
    workflowVersionId?: string;
  }> = {},
) {
  const inputWorkspaceId = options.workspaceId ?? workspaceId;
  const inputWorkflowId = options.workflowId ?? workflowId;
  const inputWorkflowVersionId = options.workflowVersionId ?? workflowVersionId;
  return {
    actorId,
    workspaceId: inputWorkspaceId,
    workflowId: inputWorkflowId,
    idempotencyKeyHash,
    requestHash,
    scope: `workflow:${inputWorkflowId}:manual`,
    input: { customerId: 'customer-42' },
    requestId: 'request-42',
    traceId: 'trace-42',
    checkpointFactory: (projection: Readonly<{ id: string }>) => {
      expect(projection.id).toBe(inputWorkflowVersionId);
      return {
        checkpoint: checkpoint(inputWorkflowVersionId),
      };
    },
  } as const;
}

export function replayInput(
  sourceRunId: string,
  requestHash = digest('replay-request-1'),
  {
    idempotencyKeyHash = digest('replay-key-1'),
    selectedWorkflowVersionId = workflowVersionId,
    deadlineAt,
  }: Readonly<{
    idempotencyKeyHash?: string | undefined;
    selectedWorkflowVersionId?: string | undefined;
    deadlineAt?: Date | undefined;
  }> = {},
) {
  return {
    actorId,
    workspaceId,
    sourceRunId,
    workflowVersionId: selectedWorkflowVersionId,
    idempotencyKeyHash,
    requestHash,
    scope: `workflow:${sourceRunId}:replay`,
    input: { customerId: 'replay-customer-42' },
    requestId: 'replay-request-42',
    traceId: 'replay-trace-42',
    checkpointFactory: (projection: Readonly<{ id: string }>) => {
      expect(projection.id).toBe(selectedWorkflowVersionId);
      return {
        checkpoint: checkpoint(selectedWorkflowVersionId),
      };
    },
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  } as const;
}

export async function ownerQuery(
  text: string,
  values: readonly unknown[] = [],
  contextWorkspaceId = workspaceId,
) {
  const client = await owner.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      contextWorkspaceId,
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

export async function apiQuery<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<Row>> {
  const client = await api.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await client.query<Row>(text, [...values]);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function apiQueryWithIndexPreference(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult> {
  const client = await api.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    await client.query('set local enable_seqscan = off');
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

export async function resetFixture(): Promise<void> {
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
    `insert into app.workspace_memberships (workspace_id,user_id,role,status)
     values ($1,$2,'owner','active')`,
    [workspaceId, actorId],
  );
  await ownerQuery(
    `insert into app.workspace_memberships (workspace_id,user_id,role,status)
     values ($1,$2,'owner','active')`,
    [otherWorkspaceId, actorId],
    otherWorkspaceId,
  );
  await ownerQuery(
    `insert into app.workflows
       (id, workspace_id, name, lifecycle_status, activation_status,
        created_by)
     values ($1, $2, 'Executable Run API', 'active', 'inactive', $3)`,
    [workflowId, workspaceId, actorId],
  );
  await ownerQuery(
    `insert into app.workflows
       (id, workspace_id, name, lifecycle_status, activation_status,
        created_by)
     values ($1, $2, 'Other Executable Run API', 'active', 'inactive', $3)`,
    [otherWorkflowId, otherWorkspaceId, actorId],
    otherWorkspaceId,
  );
  await ownerQuery(
    `insert into app.workflow_versions
       (id, workspace_id, workflow_id, version_number,
        graph_json, checksum, executable_json, published_by)
     values
       ($1, $2, $3, 1, $4::jsonb, $5, $6::jsonb, $7),
       ($8, $2, $3, 2,
        jsonb_set($4::jsonb, '{settings}', '{"maxRunDurationMs":5000}'::jsonb),
        $9, $10::jsonb, $7)`,
    [
      workflowVersionId,
      workspaceId,
      workflowId,
      JSON.stringify({ edges: [], nodes: [], settings: {} }),
      `wf:sha256:${'a'.repeat(64)}`,
      JSON.stringify({ marker: 'run-api' }),
      actorId,
      retainedWorkflowVersionId,
      `wf:sha256:${'b'.repeat(64)}`,
      JSON.stringify({
        marker: 'run-api-retained',
        graph: { settings: { maxRunDurationMs: 5_000 } },
      }),
    ],
  );
  await ownerQuery(
    `insert into app.workflow_versions
       (id, workspace_id, workflow_id, version_number,
        graph_json, checksum, executable_json, published_by)
     values ($1, $2, $3, 1, $4::jsonb, $5, $6::jsonb, $7)`,
    [
      otherWorkflowVersionId,
      otherWorkspaceId,
      otherWorkflowId,
      JSON.stringify({ edges: [], nodes: [], settings: {} }),
      `wf:sha256:${'c'.repeat(64)}`,
      JSON.stringify({ marker: 'run-api-other' }),
      actorId,
    ],
    otherWorkspaceId,
  );
  await ownerQuery(
    `update app.workflows set published_version_id = $2 where id = $1`,
    [workflowId, workflowVersionId],
  );
  await ownerQuery(
    `update app.workflows set published_version_id = $2 where id = $1`,
    [otherWorkflowId, otherWorkflowVersionId],
    otherWorkspaceId,
  );
}

export async function beforeAllFixture1() {
  await disposableDatabase.create();
  try {
    await migrateDatabase(migrationConfig);
  } catch (error: unknown) {
    await disposableDatabase.drop().catch(() => undefined);
    throw error;
  }
}

export async function afterAllFixture2() {
  const outcomes = await Promise.allSettled([
    database.close(),
    api.end(),
    owner.end(),
  ]);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
  );
  try {
    await disposableDatabase.drop();
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Workflow-run API fixture cleanup failed',
    );
}
