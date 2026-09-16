import { createHash, randomUUID } from 'node:crypto';

import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { CompatibilityReleaseMismatchError } from '../src/compatibility/compatibility-release.js';
import {
  IdempotencyRequestConflictError,
  WorkspaceRunAdmissionDeniedError,
} from '../src/execution/execution-acceptance.js';
import { migrateDatabase } from '../src/migrations.js';
import {
  createWorkflowRunDatabase,
  WorkflowRunNotFoundError,
  WorkflowRunNotExecutableError,
  WorkflowRunReadCapacityError,
} from '../src/execution/workflow-run-api.js';
import type { ExecutionStateConflictError } from '../src/execution/execution-state.js';
import { BASELINE_COMPATIBILITY_EXPECTATION } from './baseline-compatibility-fixture.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const databaseName = `pertexo_test_run_api_${randomUUID().replaceAll('-', '')}`;
const disposableDatabase = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_api'],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const migrationUrl = disposableDatabase.databaseUrl(migrationBaseUrl);
const apiUrl = disposableDatabase.databaseUrl(apiBaseUrl);
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const actorId = randomUUID();
const workflowId = randomUUID();
const workflowVersionId = randomUUID();
const retainedWorkflowVersionId = randomUUID();
const otherWorkflowId = randomUUID();
const otherWorkflowVersionId = randomUUID();
const owner = new Pool({ connectionString: migrationUrl, max: 1 });
const api = new Pool({ connectionString: apiUrl, max: 1 });
const database = createWorkflowRunDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
  BASELINE_COMPATIBILITY_EXPECTATION,
);
const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function checkpoint(versionId: string = workflowVersionId) {
  return {
    schemaVersion: 1,
    engineVersion: 'phase3-engine-v1',
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
  } as const;
}

function startInput(
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
        engineVersion: 'phase3-engine-v1',
        checkpoint: checkpoint(inputWorkflowVersionId),
      };
    },
  } as const;
}

function replayInput(
  sourceRunId: string,
  requestHash = digest('replay-request-1'),
  idempotencyKeyHash = digest('replay-key-1'),
  selectedWorkflowVersionId = workflowVersionId,
  deadlineAt?: Date,
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
        engineVersion: 'phase3-engine-v1',
        checkpoint: checkpoint(selectedWorkflowVersionId),
      };
    },
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  } as const;
}

async function ownerQuery(
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

async function apiQuery<Row extends QueryResultRow = QueryResultRow>(
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

async function apiQueryWithIndexPreference(
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
    `insert into app.workflows
       (id, workspace_id, name, lifecycle_status, activation_status,
        created_by)
     values ($1, $2, 'Other Executable Run API', 'active', 'inactive', $3)`,
    [otherWorkflowId, otherWorkspaceId, actorId],
    otherWorkspaceId,
  );
  await ownerQuery(
    `insert into app.workflow_versions
       (id, workspace_id, workflow_id, version_number, schema_version,
        graph_json, checksum, executable_schema_version, executable_json,
        compatibility_release_epoch, published_by)
     values
       ($1, $2, $3, 1, 1, $4::jsonb, $5, 2, $6::jsonb, 1, $7),
       ($8, $2, $3, 2, 1, $4::jsonb, $9, 2, $10::jsonb, 1, $7)`,
    [
      workflowVersionId,
      workspaceId,
      workflowId,
      JSON.stringify({ edges: [], nodes: [], schemaVersion: 1, settings: {} }),
      `wf:v2:sha256:${'a'.repeat(64)}`,
      JSON.stringify({ schemaVersion: 2, marker: 'run-api' }),
      actorId,
      retainedWorkflowVersionId,
      `wf:v2:sha256:${'b'.repeat(64)}`,
      JSON.stringify({ schemaVersion: 2, marker: 'run-api-retained' }),
    ],
  );
  await ownerQuery(
    `insert into app.workflow_versions
       (id, workspace_id, workflow_id, version_number, schema_version,
        graph_json, checksum, executable_schema_version, executable_json,
        compatibility_release_epoch, published_by)
     values ($1, $2, $3, 1, 1, $4::jsonb, $5, 2, $6::jsonb, 1, $7)`,
    [
      otherWorkflowVersionId,
      otherWorkspaceId,
      otherWorkflowId,
      JSON.stringify({ edges: [], nodes: [], schemaVersion: 1, settings: {} }),
      `wf:v2:sha256:${'c'.repeat(64)}`,
      JSON.stringify({ schemaVersion: 2, marker: 'run-api-other' }),
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

beforeAll(async () => {
  await disposableDatabase.create();
  try {
    await migrateDatabase(migrationConfig);
  } catch (error: unknown) {
    await disposableDatabase.drop().catch(() => undefined);
    throw error;
  }
});

beforeEach(resetFixture);

afterAll(async () => {
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
});

describe('workflow run API persistence', () => {
  it('paginates sub-millisecond run history completely without duplicates or cross-workspace rows', async () => {
    const first = await database.start(
      startInput(digest('history-request-1'), digest('history-key-1')),
    );
    const second = await database.start(
      startInput(digest('history-request-2'), digest('history-key-2')),
    );
    const filtered = await database.start(
      startInput(digest('history-request-3'), digest('history-key-3')),
    );
    const other = await database.start(
      startInput(digest('history-request-other'), digest('history-key-other'), {
        workspaceId: otherWorkspaceId,
        workflowId: otherWorkflowId,
        workflowVersionId: otherWorkflowVersionId,
      }),
    );
    await ownerQuery(
      `update app.workflow_runs
       set created_at = case id
         when $1 then '2026-08-21T12:00:00.000100Z'::timestamptz
         when $2 then '2026-08-21T12:00:00.000900Z'::timestamptz
       end,
       input_ref_expires_at = case id
         when $1 then '2026-09-20T12:00:00.000100Z'::timestamptz
         when $2 then '2026-09-20T12:00:00.000900Z'::timestamptz
       end,
       status = 'succeeded'
       where id in ($1, $2)`,
      [first.run.id, second.run.id],
    );
    await ownerQuery(
      `update app.workflow_runs
       set created_at = '2026-08-21T12:00:00.001500Z'::timestamptz,
           input_ref_expires_at = '2026-09-20T12:00:00.001500Z'::timestamptz,
           status = 'failed'
       where id = $1`,
      [filtered.run.id],
    );
    await ownerQuery(
      `update app.workflow_runs
       set created_at = '2026-08-21T12:00:00.000950Z'::timestamptz,
           input_ref_expires_at = '2026-09-20T12:00:00.000950Z'::timestamptz
       where id = $1`,
      [other.run.id],
      otherWorkspaceId,
    );

    const seen: string[] = [];
    let after: Readonly<{ createdAt: string; id: string }> | undefined;
    do {
      const page = await database.list({
        workspaceId,
        workflowId,
        limit: 1,
        createdAtFrom: '2026-08-21T12:00:00.000000Z',
        createdAtBefore: '2026-08-21T12:00:00.001000Z',
        ...(after === undefined ? {} : { after }),
      });
      seen.push(...page.items.map(({ id }) => id));
      after = page.nextCursor;
    } while (after !== undefined);

    expect(seen).toHaveLength(2);
    expect(new Set(seen)).toEqual(new Set([first.run.id, second.run.id]));
    expect(seen).not.toContain(other.run.id);
    await expect(
      database.list({ workspaceId, workflowId, status: 'failed', limit: 10 }),
    ).resolves.toMatchObject({ items: [{ id: filtered.run.id }] });

    const indexes = await ownerQuery(
      `select indexname from pg_indexes
       where schemaname = 'app' and indexname in
         ('workflow_runs_workspace_created_idx',
          'workflow_runs_workspace_workflow_created_idx')
       order by indexname`,
    );
    expect(indexes.rows).toEqual([
      { indexname: 'workflow_runs_workspace_created_idx' },
      { indexname: 'workflow_runs_workspace_workflow_created_idx' },
    ]);
    const plan = await apiQueryWithIndexPreference(
      `explain (format json)
       select id from app.workflow_runs
       where workspace_id = $1 and workflow_id = $2
       order by created_at desc, id desc
       limit 50`,
      [workspaceId, workflowId],
    );
    expect(JSON.stringify(plan.rows)).toContain(
      'workflow_runs_workspace_workflow_created_idx',
    );
  });

  it('resolves an exact replay before checking the current compatibility release', async () => {
    const first = await database.start(startInput());
    const drifted = createWorkflowRunDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        ...BASELINE_COMPATIBILITY_EXPECTATION,
        fingerprint:
          'node-compat:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    );
    try {
      await expect(drifted.start(startInput())).resolves.toEqual({
        ...first,
        replayed: true,
      });
      await expect(
        drifted.start(startInput(digest('request-2'), digest('key-2'))),
      ).rejects.toBeInstanceOf(CompatibilityReleaseMismatchError);
    } finally {
      await drifted.close();
    }
  });

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

  it('maps a nonempty node snapshot and enforces the exact read-capacity boundary', async () => {
    const started = await database.start(startInput());
    await ownerQuery(
      `insert into app.node_runs
         (id,workspace_id,workflow_run_id,node_id,invocation_key,
          branch_context,status,side_effect_class)
       select gen_random_uuid(),$1,$2,'node-'||ordinal,'node-'||ordinal,
              '{}'::jsonb,'pending','safe'
       from generate_series(1,1000) ordinal`,
      [workspaceId, started.run.id],
    );
    const exact = await database.get({ workspaceId, runId: started.run.id });
    expect(exact?.nodes).toHaveLength(1_000);
    expect(
      exact?.nodes.find((node) => node.invocationKey === 'node-1'),
    ).toMatchObject({
      currentAttemptNumber: 0,
      invocationKey: 'node-1',
      status: 'pending',
    });

    await ownerQuery(
      `insert into app.node_runs
         (id,workspace_id,workflow_run_id,node_id,invocation_key,
          branch_context,status,side_effect_class)
       values(gen_random_uuid(),$1,$2,'overflow','overflow','{}','pending','safe')`,
      [workspaceId, started.run.id],
    );
    await expect(
      database.get({ workspaceId, runId: started.run.id }),
    ).rejects.toBeInstanceOf(WorkflowRunReadCapacityError);
  });

  it('distinguishes exact, conflicting, absent-reason, and terminal cancellation', async () => {
    const started = await database.start(startInput());
    const first = await database.cancel({
      actorId,
      workspaceId,
      runId: started.run.id,
    });
    expect(first).toMatchObject({ alreadyRequested: false, eventSequence: 2 });

    await expect(
      database.cancel({
        actorId: randomUUID(),
        workspaceId,
        runId: started.run.id,
      }),
    ).rejects.toMatchObject({ message: 'execution.cancel_request_conflict' });
    await expect(
      database.cancel({
        actorId,
        workspaceId,
        runId: started.run.id,
        reason: 'different reason',
      }),
    ).rejects.toMatchObject({ message: 'execution.cancel_request_conflict' });

    await ownerQuery(
      `update app.workflow_runs
          set status='succeeded',started_at=clock_timestamp(),
              completed_at=clock_timestamp()
        where id=$1`,
      [started.run.id],
    );
    await expect(
      database.cancel({ actorId, workspaceId, runId: started.run.id }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ExecutionStateConflictError>>({
        message: 'execution.run_terminal',
      }),
    );
    const effects = await apiQuery(
      `select
         (select count(*)::int from app.run_events) events,
         (select count(*)::int from app.outbox_events) outbox,
         (select count(*)::int from app.audit_events) audits`,
    );
    expect(effects.rows).toEqual([{ events: 2, outbox: 2, audits: 2 }]);
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

  it('atomically accepts an explicit replay while preserving the source run', async () => {
    const source = await database.start(startInput());
    const replay = await database.replay(replayInput(source.run.id));

    expect(replay.replayed).toBe(false);
    expect(replay.run.id).not.toBe(source.run.id);
    expect(replay.run).toMatchObject({
      workflowId,
      workflowVersionId,
      status: 'queued',
      triggerType: 'replay',
    });
    await expect(
      database.get({ workspaceId, runId: source.run.id }),
    ).resolves.toMatchObject({
      run: {
        id: source.run.id,
        triggerType: 'manual',
        workflowVersionId,
      },
      nodes: [],
    });

    const lineage = await apiQuery<{
      replay_source_run_id: string;
      replay_command_id: string;
      trigger_type: string;
    }>(
      `select replay_source_run_id,replay_command_id,trigger_type
       from app.workflow_runs where id=$1`,
      [replay.run.id],
    );
    expect(lineage.rows).toHaveLength(1);
    const lineageRow = lineage.rows[0];
    if (lineageRow === undefined) throw new Error('Replay lineage is missing');
    expect(lineageRow.replay_source_run_id).toBe(source.run.id);
    expect(lineageRow.trigger_type).toBe('replay');
    expect(lineageRow.replay_command_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    await expect(database.replay(replayInput(source.run.id))).resolves.toEqual({
      ...replay,
      replayed: true,
    });
    await expect(
      database.replay(replayInput(source.run.id, digest('replay-request-2'))),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);

    const effects = await apiQuery(
      `select
         (select count(*)::int from app.workflow_runs) runs,
         (select count(*)::int from app.run_checkpoints) checkpoints,
         (select count(*)::int from app.run_events) events,
         (select count(*)::int from app.outbox_events) outbox,
         (select count(*)::int from app.audit_events) audits`,
    );
    expect(effects.rows).toEqual([
      { runs: 2, checkpoints: 2, events: 2, outbox: 2, audits: 2 },
    ]);
  });

  it('serializes concurrent exact replay requests to one durable run', async () => {
    const source = await database.start(
      startInput(digest('race-source-request'), digest('race-source-key')),
    );
    const outcomes = await Promise.all([
      database.replay(
        replayInput(
          source.run.id,
          digest('race-replay-request'),
          digest('race-replay-key'),
        ),
      ),
      database.replay(
        replayInput(
          source.run.id,
          digest('race-replay-request'),
          digest('race-replay-key'),
        ),
      ),
    ]);

    expect(outcomes.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(outcomes[0].run.id).toBe(outcomes[1].run.id);
    const effects = await apiQuery(
      `select
         (select count(*)::int from app.workflow_runs) runs,
         (select count(*)::int from app.run_checkpoints) checkpoints,
         (select count(*)::int from app.run_events) events,
         (select count(*)::int from app.outbox_events) outbox,
         (select count(*)::int from app.audit_events) audits,
         (select count(*)::int from app.idempotency_records) idempotency`,
    );
    expect(effects.rows).toEqual([
      {
        runs: 2,
        checkpoints: 2,
        events: 2,
        outbox: 2,
        audits: 2,
        idempotency: 2,
      },
    ]);
  });

  it('replays against an explicitly selected retained version without republishing it', async () => {
    const source = await database.start(
      startInput(
        digest('retained-source-request'),
        digest('retained-source-key'),
      ),
    );
    const replay = await database.replay(
      replayInput(
        source.run.id,
        digest('retained-replay-request'),
        digest('retained-replay-key'),
        retainedWorkflowVersionId,
      ),
    );

    expect(replay.run).toMatchObject({
      workflowVersionId: retainedWorkflowVersionId,
      triggerType: 'replay',
    });
    const state = await apiQuery(
      `select run.workflow_version_id,
              checkpoint.scheduler_state->>'workflowVersionId' checkpoint_version_id,
              workflow.published_version_id
         from app.workflow_runs run
         join app.run_checkpoints checkpoint
           on checkpoint.workspace_id=run.workspace_id
          and checkpoint.workflow_run_id=run.id
         join app.workflows workflow
           on workflow.workspace_id=run.workspace_id
          and workflow.id=run.workflow_id
        where run.id=$1`,
      [replay.run.id],
    );
    expect(state.rows).toEqual([
      {
        workflow_version_id: retainedWorkflowVersionId,
        checkpoint_version_id: retainedWorkflowVersionId,
        published_version_id: workflowVersionId,
      },
    ]);
  });

  it('rejects replay admission and rolls back the acceptance claim', async () => {
    const source = await database.start(
      startInput(
        digest('admission-source-request'),
        digest('admission-source-key'),
      ),
    );
    await ownerQuery(
      `insert into app.workspace_execution_entitlement_versions
         (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
       values ($1,2,'suspended',5,100,'-infinity'::timestamptz)`,
      [workspaceId],
    );
    await ownerQuery(
      `update app.workspace_execution_entitlements
          set current_version=2
        where workspace_id=$1`,
      [workspaceId],
    );

    await expect(
      database.replay(
        replayInput(
          source.run.id,
          digest('admission-replay-request'),
          digest('admission-replay-key'),
        ),
      ),
    ).rejects.toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
    const effects = await apiQuery(
      `select
         (select count(*)::int from app.workflow_runs) runs,
         (select count(*)::int from app.run_checkpoints) checkpoints,
         (select count(*)::int from app.run_events) events,
         (select count(*)::int from app.outbox_events) outbox,
         (select count(*)::int from app.audit_events) audits,
         (select count(*)::int from app.idempotency_records) idempotency`,
    );
    expect(effects.rows).toEqual([
      {
        runs: 1,
        checkpoints: 1,
        events: 1,
        outbox: 1,
        audits: 1,
        idempotency: 1,
      },
    ]);
  });

  it('hides cross-tenant replay sources and versions without side effects', async () => {
    const otherSource = await database.start(
      startInput(digest('other-source-request'), digest('other-source-key'), {
        workspaceId: otherWorkspaceId,
        workflowId: otherWorkflowId,
        workflowVersionId: otherWorkflowVersionId,
      }),
    );
    await expect(
      database.replay(
        replayInput(
          otherSource.run.id,
          digest('cross-source-request'),
          digest('cross-source-key'),
        ),
      ),
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);

    const source = await database.start(
      startInput(digest('cross-version-source'), digest('cross-version-key')),
    );
    await expect(
      database.replay(
        replayInput(
          source.run.id,
          digest('cross-version-request'),
          digest('cross-version-replay-key'),
          otherWorkflowVersionId,
        ),
      ),
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);

    const effects = await apiQuery(
      `select
         (select count(*)::int from app.workflow_runs) runs,
         (select count(*)::int from app.run_checkpoints) checkpoints,
         (select count(*)::int from app.run_events) events,
         (select count(*)::int from app.outbox_events) outbox,
         (select count(*)::int from app.audit_events) audits,
         (select count(*)::int from app.idempotency_records) idempotency`,
    );
    expect(effects.rows).toEqual([
      {
        runs: 1,
        checkpoints: 1,
        events: 1,
        outbox: 1,
        audits: 1,
        idempotency: 1,
      },
    ]);
  });

  it('rolls back a replay acceptance when a downstream run constraint fails', async () => {
    const source = await database.start(
      startInput(
        digest('rollback-source-request'),
        digest('rollback-source-key'),
      ),
    );

    await expect(
      database.replay(
        replayInput(
          source.run.id,
          digest('rollback-replay-request'),
          digest('rollback-replay-key'),
          workflowVersionId,
          new Date(0),
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    const effects = await apiQuery(
      `select
         (select count(*)::int from app.workflow_runs) runs,
         (select count(*)::int from app.run_checkpoints) checkpoints,
         (select count(*)::int from app.run_events) events,
         (select count(*)::int from app.outbox_events) outbox,
         (select count(*)::int from app.audit_events) audits,
         (select count(*)::int from app.idempotency_records) idempotency`,
    );
    expect(effects.rows).toEqual([
      {
        runs: 1,
        checkpoints: 1,
        events: 1,
        outbox: 1,
        audits: 1,
        idempotency: 1,
      },
    ]);
  });

  it('keeps replay locks behind owner-defined reads and API insert-only grants', async () => {
    const source = await database.start(
      startInput(digest('lock-request'), digest('lock-key')),
    );

    await expect(
      apiQuery(`update app.workflow_runs set id=$2 where id=$1`, [
        source.run.id,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      apiQuery(`update app.workflow_versions set id=$2 where id=$1`, [
        workflowVersionId,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      apiQuery(`select * from app.lock_workflow_run_replay_source($1,$2)`, [
        otherWorkspaceId,
        source.run.id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      apiQuery(`select * from app.lock_workflow_run_replay_version($1,$2,$3)`, [
        otherWorkspaceId,
        workflowId,
        workflowVersionId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      apiQuery(`select * from app.lock_workflow_run_replay_source($1,$2)`, [
        workspaceId,
        null,
      ]),
    ).rejects.toMatchObject({ code: '22023' });

    await expect(
      apiQuery(
        `select workflow_id,lifecycle_status
         from app.lock_workflow_run_replay_source($1,$2)`,
        [workspaceId, source.run.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ workflow_id: workflowId, lifecycle_status: 'active' }],
    });

    const lockClient = await owner.connect();
    const probeClient = await api.connect();
    try {
      await lockClient.query('begin');
      await lockClient.query('set local role pertexo_owner');
      await lockClient.query(`select set_config('app.workspace_id',$1,true)`, [
        workspaceId,
      ]);
      await lockClient.query(
        `select id from app.workflow_runs where id=$1 for update`,
        [source.run.id],
      );

      await probeClient.query('begin');
      await probeClient.query(`select set_config('app.workspace_id',$1,true)`, [
        workspaceId,
      ]);
      await probeClient.query(`set local statement_timeout='100ms'`);
      await expect(
        probeClient.query(
          `select * from app.lock_workflow_run_replay_source($1,$2)`,
          [workspaceId, source.run.id],
        ),
      ).rejects.toMatchObject({ code: '57014' });
      await probeClient.query('rollback');
      await lockClient.query('rollback');
    } finally {
      await probeClient.query('rollback').catch(() => undefined);
      probeClient.release();
      await lockClient.query('rollback').catch(() => undefined);
      lockClient.release();
    }
  });
});
