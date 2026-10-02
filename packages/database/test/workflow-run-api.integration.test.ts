import { createHash, randomUUID } from 'node:crypto';

import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { CompatibilityReleaseMismatchError } from '../src/compatibility/compatibility-release.js';
import {
  IdempotencyRequestConflictError,
  WorkspaceRunAdmissionDeniedError,
} from '../src/execution/runs/execution-acceptance.js';
import { migrateDatabase } from '../src/migrations.js';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import { WorkflowManualStartUnavailableError } from '../src/execution/runs/workflow-run-errors.js';
import {
  createWorkflowRunDatabase,
  WorkflowRunNotFoundError,
  WorkflowRunNotExecutableError,
  WorkflowRunReadCapacityError,
  WorkflowPublishedVersionConflictError,
} from '../src/execution/runs/workflow-run-api.js';
import type { ExecutionStateConflictError } from '../src/execution/runs/execution-state.js';
import { BASELINE_COMPATIBILITY_EXPECTATION } from './baseline-compatibility-fixture.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';
import { explainDocument, explainWork } from './support/query-plan.js';

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
  await ownerQuery('update app.workflow_input_case_rollout set enabled=true');
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
       (id, workspace_id, workflow_id, version_number, schema_version,
        graph_json, checksum, executable_schema_version, executable_json,
        compatibility_release_epoch, published_by)
     values
       ($1, $2, $3, 1, 1, $4::jsonb, $5, 2, $6::jsonb, 1, $7),
       ($8, $2, $3, 2, 1,
        jsonb_set($4::jsonb, '{settings}', '{"maxRunDurationMs":5000}'::jsonb),
        $9, 2, $10::jsonb, 1, $7)`,
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
      JSON.stringify({
        schemaVersion: 2,
        marker: 'run-api-retained',
        graph: { settings: { maxRunDurationMs: 5_000 } },
      }),
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
  it.each([
    [
      'alter table app.workflow_runs disable trigger manual_start_writer_fence',
      'alter table app.workflow_runs enable trigger manual_start_writer_fence',
    ],
    [
      'grant select on app.workflow_manual_start_rejections to pertexo_worker',
      'revoke select on app.workflow_manual_start_rejections from pertexo_worker',
    ],
    [
      'create policy test_manual_receipt_bypass on app.workflow_manual_start_rejections to pertexo_api using(true)',
      'drop policy test_manual_receipt_bypass on app.workflow_manual_start_rejections',
    ],
    [
      'grant update on app.workflow_input_case_rollout to pertexo_api',
      'revoke update on app.workflow_input_case_rollout from pertexo_api',
    ],
    [
      'alter function app.lock_manual_workflow_run_start(uuid,uuid,text,text) set search_path=pg_catalog,public',
      'alter function app.lock_manual_workflow_run_start(uuid,uuid,text,text) set search_path=pg_catalog,pg_temp',
    ],
  ])('rejects checked-start startup drift: %s', async (tamper, restore) => {
    await expect(checkDatabaseReadiness(api)).resolves.toMatchObject({
      migrationHead: '0133_curated_template_origin.sql',
    });
    await ownerQuery(tamper);
    try {
      await expect(checkDatabaseReadiness(api)).rejects.toThrow(
        'Published workflow execution schema is incompatible',
      );
    } finally {
      await ownerQuery(restore);
    }
    await expect(checkDatabaseReadiness(api)).resolves.toMatchObject({
      migrationHead: '0133_curated_template_origin.sql',
    });
  });

  it('counts filtered rows as plan work even when a scan emits no rows', () => {
    expect(
      explainWork({
        'Node Type': 'Seq Scan',
        'Actual Rows': 0,
        'Actual Loops': 1,
        'Rows Removed by Filter': 10_000,
        'Shared Hit Blocks': 125,
      }),
    ).toEqual({
      outputRowInstances: 0,
      rejectedRowInstances: 10_000,
      summedNodeRowWork: 10_000,
      rootSharedBufferTouches: 125,
      nodeTypes: ['Seq Scan'],
    });
  });

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
        workflowNamePrefix: 'Executable Run',
        includeWorkflowName: true,
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
    const named = await database.list({
      workspaceId,
      workflowNamePrefix: 'Executable Run API',
      includeWorkflowName: true,
      limit: 10,
    });
    expect(named.items.length).toBeGreaterThan(0);
    expect(
      named.items.every(
        ({ workflowName }) => workflowName === 'Executable Run API',
      ),
    ).toBe(true);
    await expect(
      database.list({
        workspaceId,
        workflowNamePrefix: 'Executable Run API%',
        includeWorkflowName: true,
        limit: 10,
      }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      database.list({
        workspaceId,
        workflowNamePrefix: 'Executable Run API\\',
        includeWorkflowName: true,
        limit: 10,
      }),
    ).resolves.toMatchObject({ items: [] });
    await ownerQuery(
      `update app.workflows set name = 'Éxecutable Run API'
       where workspace_id = $1 and id = $2`,
      [workspaceId, workflowId],
    );
    const literalSpecials = await database.list({
      workspaceId,
      workflowNamePrefix: 'Éxecutable',
      includeWorkflowName: true,
      limit: 10,
    });
    expect(literalSpecials.items.length).toBeGreaterThan(0);
    expect(
      literalSpecials.items.every(
        ({ workflowName }) => workflowName === 'Éxecutable Run API',
      ),
    ).toBe(true);
    await ownerQuery(
      `update app.workflows set lifecycle_status = 'archived'
       where workspace_id = $1 and id = $2`,
      [workspaceId, workflowId],
    );
    const archivedNamed = await database.list({
      workspaceId,
      workflowNamePrefix: 'Éxecutable',
      includeWorkflowName: true,
      limit: 10,
    });
    expect(
      archivedNamed.items.some(
        ({ workflowName }) => workflowName === 'Éxecutable Run API',
      ),
    ).toBe(true);
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
    const namePlan = await apiQueryWithIndexPreference(
      `explain (analyze, buffers, format json)
       select run.id
       from app.workflow_runs run
       join app.workflows workflow
         on workflow.workspace_id = run.workspace_id
        and workflow.id = run.workflow_id
       where run.workspace_id = $1
         and lower(workflow.name) like lower($2) || '%' escape '\\'
       order by run.created_at desc, run.id desc
       limit 50`,
      [workspaceId, 'Éxecutable'],
    );
    expect(JSON.stringify(namePlan.rows)).toContain(
      'workflow_runs_workspace_created_idx',
    );
  });

  it('records production-shaped name-filter work under normal planner settings', async () => {
    await ownerQuery(
      `insert into app.workflows
         (id, workspace_id, name, lifecycle_status, activation_status, created_by)
       select gen_random_uuid(), $1,
              case
                when ordinal <= 20 then 'Common workflow ' || ordinal
                when ordinal = 21 then 'Selective needle'
                else 'Other workflow ' || ordinal
              end,
              'active', 'inactive', $2
       from generate_series(1, 40) ordinal`,
      [workspaceId, actorId],
    );
    await ownerQuery(
      `insert into app.workflow_versions
         (id, workspace_id, workflow_id, version_number, schema_version,
          graph_json, checksum, executable_schema_version, executable_json,
          compatibility_release_epoch, published_by)
       select gen_random_uuid(), $1, workflow.id, 1, 1,
              '{"schemaVersion":1,"nodes":[],"edges":[],"settings":{}}'::jsonb,
              'wf:v2:sha256:' || repeat('d', 64), 2,
              '{"schemaVersion":2}'::jsonb, 1, $2
       from app.workflows workflow
       where workflow.workspace_id = $1
         and workflow.name similar to '(Common|Selective|Other)%'`,
      [workspaceId, actorId],
    );
    // This test measures read plans, not run admission. Seed terminal history
    // with the disposable database admin so the per-row admission recount does
    // not consume the test's fixed 15-second budget before EXPLAIN runs.
    // The disabled trigger normally allocates mandatory admission tickets, so
    // only this privileged historical seed uses the private sequence directly.
    const fixtureAdmin = new Pool({
      connectionString: disposableDatabase.databaseUrl(adminUrl),
      max: 1,
    });
    try {
      const seedClient = await fixtureAdmin.connect();
      try {
        await seedClient.query('begin');
        await seedClient.query(
          'alter table app.workflow_runs disable trigger workflow_runs_execution_admission',
        );
        await seedClient.query(
          'alter table app.workflow_runs disable trigger workflow_runs_refresh_execution_admission',
        );
        await seedClient.query(
          `insert into app.workflow_runs
         (id, workspace_id, workflow_id, workflow_version_id,
          trigger_type, status, execution_entitlement_version, admission_ticket,
          created_at, updated_at)
       select gen_random_uuid(), $1, workflow.id, version.id, 'manual',
              case when run_number % 2 = 0 then 'failed' else 'succeeded' end,
              1,
              nextval('app.workflow_run_admission_ticket_seq'),
              '2026-09-01T00:00:00Z'::timestamptz
                + ((row_number() over ())::text || ' milliseconds')::interval,
              '2026-09-01T00:00:00Z'::timestamptz
                + ((row_number() over ())::text || ' milliseconds')::interval
       from app.workflows workflow
       join app.workflow_versions version
         on version.workspace_id = workflow.workspace_id
        and version.workflow_id = workflow.id
       cross join generate_series(1, 250) run_number
       where workflow.workspace_id = $1
         and workflow.name similar to '(Common|Selective|Other)%'`,
          [workspaceId],
        );
        await seedClient.query(
          'alter table app.workflow_runs enable trigger workflow_runs_refresh_execution_admission',
        );
        await seedClient.query(
          'alter table app.workflow_runs enable trigger workflow_runs_execution_admission',
        );
        await seedClient.query('commit');
        const triggers = await seedClient.query<{
          tgname: string;
          tgenabled: string;
        }>(
          `select tgname,tgenabled from pg_trigger
            where tgrelid='app.workflow_runs'::regclass
              and tgname in ('workflow_runs_execution_admission',
                             'workflow_runs_refresh_execution_admission')
            order by tgname`,
        );
        expect(triggers.rows).toEqual([
          { tgname: 'workflow_runs_execution_admission', tgenabled: 'O' },
          {
            tgname: 'workflow_runs_refresh_execution_admission',
            tgenabled: 'O',
          },
        ]);
      } catch (error) {
        await seedClient.query('rollback');
        throw error;
      } finally {
        seedClient.release();
      }
    } finally {
      await fixtureAdmin.end();
    }
    const cardinality = await apiQuery<{ workflows: number; runs: number }>(
      `select count(distinct workflow_id)::integer workflows,
              count(*)::integer runs
         from app.workflow_runs where workspace_id=$1
           and created_at >= '2026-09-01T00:00:00Z'::timestamptz`,
      [workspaceId],
    );
    expect(cardinality.rows[0]).toEqual({ workflows: 40, runs: 10_000 });
    await ownerQuery('analyze app.workflows');
    await ownerQuery('analyze app.workflow_runs');

    const explain = async (
      prefix: string | null,
      status: string | null,
      after: string | null,
    ) =>
      explainDocument(
        await apiQuery(
          `explain (analyze, buffers, settings, format json)
           select run.id
           from app.workflow_runs run
           left join app.workflows workflow
             on workflow.workspace_id = run.workspace_id
            and workflow.id = run.workflow_id
           where run.workspace_id = $1
             and ($2::text is null
               or lower(workflow.name) like lower($2::text) || '%' escape '\\')
             and ($3::text is null or run.status = $3::text)
             and ($4::timestamptz is null
               or run.created_at < $4::timestamptz
               or (run.created_at = $4::timestamptz and run.id < $5::uuid))
           order by run.created_at desc, run.id desc
           limit 50`,
          [
            workspaceId,
            prefix,
            status,
            after,
            after === null ? null : 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          ],
        ),
      );

    const evidence = {
      absent: await explain(null, null, null),
      selective: await explain('Selective', null, null),
      common: await explain('Common', null, null),
      noMatch: await explain('Missing', null, null),
      combined: await explain('Common', 'failed', null),
      deep: await explain('Common', null, '2026-09-01T00:00:02.500000Z'),
    };
    expect(evidence.absent.Plan['Actual Rows']).toBe(50);
    expect(evidence.selective.Plan['Actual Rows']).toBe(50);
    expect(evidence.common.Plan['Actual Rows']).toBe(50);
    expect(evidence.noMatch.Plan['Actual Rows']).toBe(0);
    expect(evidence.combined.Plan['Actual Rows']).toBe(50);
    expect(evidence.deep.Plan['Actual Rows']).toBe(50);
    const measured = Object.fromEntries(
      Object.entries(evidence).map(([scenario, plan]) => [
        scenario,
        {
          ...explainWork(plan.Plan),
          executionTimeMs: plan['Execution Time'],
        },
      ]),
    );
    for (const [scenario, plan] of Object.entries(evidence)) {
      expect(plan.Settings?.enable_seqscan).not.toBe('off');
      expect(measured[scenario]?.summedNodeRowWork).toBeGreaterThan(0);
      expect(measured[scenario]?.rootSharedBufferTouches).toBeGreaterThan(0);
      expect(measured[scenario]?.nodeTypes.length).toBeGreaterThan(0);
    }
    expect(measured.noMatch?.outputRowInstances).toBe(0);
    expect(measured.noMatch?.rejectedRowInstances).toBeGreaterThan(0);
  }, 15_000);

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

  it('disables new checked commands during rollback while preserving unchecked manual admission', async () => {
    await ownerQuery(
      'update app.workflow_input_case_rollout set enabled=false',
    );
    await expect(
      database.start({
        ...startInput(),
        expectedPublishedVersionId: workflowVersionId,
      }),
    ).rejects.toBeInstanceOf(WorkflowManualStartUnavailableError);
    await expect(database.start(startInput())).resolves.toMatchObject({
      replayed: false,
    });
    expect(
      (
        await ownerQuery(
          'select count(*)::int count from app.workflow_manual_start_rejections',
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });

  it('commits a stale rejection, preserves it after republication, and conflicts on changed intent', async () => {
    const input = {
      ...startInput(),
      expectedPublishedVersionId: retainedWorkflowVersionId,
    };
    await expect(database.start(input)).rejects.toBeInstanceOf(
      WorkflowPublishedVersionConflictError,
    );
    await ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [workflowId, retainedWorkflowVersionId],
    );
    await ownerQuery(
      'update app.workflow_input_case_rollout set enabled=false',
    );
    await expect(database.start(input)).rejects.toBeInstanceOf(
      WorkflowPublishedVersionConflictError,
    );
    await expect(
      database.start({ ...input, requestHash: digest('changed-intent') }),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
    const effects = await ownerQuery(`select
      (select count(*)::int from app.workflow_runs) runs,
      (select count(*)::int from app.run_checkpoints) checkpoints,
      (select count(*)::int from app.outbox_events) outbox,
      (select count(*)::int from app.workflow_manual_start_rejections) rejections`);
    expect(effects.rows).toEqual([
      { runs: 0, checkpoints: 0, outbox: 0, rejections: 1 },
    ]);
  });

  it('recovers accepted checked duplicate requests before publication change', async () => {
    const input = {
      ...startInput(),
      expectedPublishedVersionId: workflowVersionId,
    };
    const accepted = await database.start(input);
    await ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [workflowId, retainedWorkflowVersionId],
    );
    await ownerQuery(
      'update app.workflow_input_case_rollout set enabled=false',
    );
    const duplicates = await Promise.all(
      Array.from({ length: 4 }, () => database.start(input)),
    );
    expect(duplicates).toEqual(
      Array.from({ length: 4 }, () => ({ ...accepted, replayed: true })),
    );
    expect(
      (
        await ownerQuery(
          'select count(*)::int count from app.workflow_manual_start_rejections',
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });

  it('serializes concurrent new checked starts to one acceptance and rechecks current run capability', async () => {
    const input = {
      ...startInput(),
      expectedPublishedVersionId: workflowVersionId,
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => database.start(input)),
    );
    expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    await ownerQuery(
      "update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=$2",
      [workspaceId, actorId],
    );
    await expect(database.start(input)).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError,
    );
    await ownerQuery(
      "update app.workspace_memberships set role='operator' where workspace_id=$1 and user_id=$2",
      [workspaceId, actorId],
    );
    await expect(database.start(input)).resolves.toMatchObject({
      run: { id: results[0]?.run.id },
      replayed: true,
    });
  });

  it('fences a legacy manual writer and releases a rejected key only after bounded expiry cleanup', async () => {
    await expect(
      apiQuery(
        `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
      values($1,$2,$3,$4,'manual','queued')`,
        [randomUUID(), workspaceId, workflowId, workflowVersionId],
      ),
    ).rejects.toMatchObject({ code: 'PTM01' });
    const input = {
      ...startInput(),
      expectedPublishedVersionId: retainedWorkflowVersionId,
    };
    await expect(database.start(input)).rejects.toBeInstanceOf(
      WorkflowPublishedVersionConflictError,
    );
    await ownerQuery(
      "update app.workflow_manual_start_rejections set expires_at=clock_timestamp()-interval '1 second'",
    );
    expect(
      (await ownerQuery('select app.prune_manual_start_rejections(100) count'))
        .rows,
    ).toEqual([{ count: 1 }]);
    await ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [workflowId, retainedWorkflowVersionId],
    );
    await expect(
      database.start({
        ...input,
        checkpointFactory: () => ({
          engineVersion: 'phase3-engine-v1',
          checkpoint: checkpoint(retainedWorkflowVersionId),
        }),
      }),
    ).resolves.toMatchObject({
      replayed: false,
      run: { workflowVersionId: retainedWorkflowVersionId },
    });
  });

  it('holds publication through acceptance and recovers a concurrently blocked exact duplicate', async () => {
    await ownerQuery(`create function app.test_manual_start_pause() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(1934781132); return new; end $$;
      create trigger zzz_test_manual_start_pause before insert on app.workflow_runs
        for each row execute function app.test_manual_start_pause()`);
    const gate = await owner.connect();
    const publicationPool = new Pool({
      connectionString: migrationUrl,
      max: 1,
    });
    const publisher = await publicationPool.connect();
    let first: ReturnType<typeof database.start> | undefined;
    let duplicate: ReturnType<typeof database.start> | undefined;
    let publication: Promise<QueryResult> | undefined;
    try {
      await gate.query('select pg_advisory_lock(1934781132)');
      const input = {
        ...startInput(),
        expectedPublishedVersionId: workflowVersionId,
      };
      first = database.start(input);
      await vi.waitFor(
        async () => {
          const waiting = await apiQuery(
            "select count(*)::int count from pg_stat_activity where usename='pertexo_api' and wait_event='advisory'",
          );
          expect(waiting.rows[0]?.count).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 },
      );
      duplicate = database.start(input);
      await publisher.query('begin');
      await publisher.query('set local role pertexo_owner');
      await publisher.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      publication = publisher.query(
        'update app.workflows set published_version_id=$2 where id=$1',
        [workflowId, retainedWorkflowVersionId],
      );
      await vi.waitFor(
        async () => {
          const waiting = await apiQuery(
            "select count(*)::int count from pg_stat_activity where usename='pertexo_api' and wait_event='advisory'",
          );
          expect(waiting.rows[0]?.count).toBeGreaterThanOrEqual(2);
        },
        { timeout: 3000 },
      );
      await gate.query('select pg_advisory_unlock(1934781132)');
      const accepted = await first;
      await publication;
      await publisher.query('commit');
      expect(await duplicate).toEqual({ ...accepted, replayed: true });
      expect(accepted.run.workflowVersionId).toBe(workflowVersionId);
      expect(
        (await apiQuery('select count(*)::int count from app.workflow_runs'))
          .rows,
      ).toEqual([{ count: 1 }]);
    } finally {
      await gate.query('select pg_advisory_unlock(1934781132)');
      if (publication !== undefined) await publication.catch(() => undefined);
      await publisher.query('rollback').catch(() => undefined);
      await Promise.allSettled([
        ...(first === undefined ? [] : [first]),
        ...(duplicate === undefined ? [] : [duplicate]),
      ]);
      publisher.release();
      gate.release();
      await publicationPool.end();
      await ownerQuery(
        'drop trigger zzz_test_manual_start_pause on app.workflow_runs; drop function app.test_manual_start_pause()',
      );
    }
  });

  it('rejects a checked command when publication commits before its authoritative lock', async () => {
    const publishing = await owner.connect();
    let attempted: ReturnType<typeof database.start> | undefined;
    try {
      await publishing.query('begin');
      await publishing.query('set local role pertexo_owner');
      await publishing.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await publishing.query(
        'update app.workflows set published_version_id=$2 where id=$1',
        [workflowId, retainedWorkflowVersionId],
      );
      attempted = database.start({
        ...startInput(),
        expectedPublishedVersionId: workflowVersionId,
      });
      // Attach the rejection observer before releasing publication.
      const rejected = expect(attempted).rejects.toBeInstanceOf(
        WorkflowPublishedVersionConflictError,
      );
      await publishing.query('commit');
      await rejected;
    } finally {
      await publishing.query('rollback').catch(() => undefined);
      if (attempted !== undefined) await attempted.catch(() => undefined);
      publishing.release();
    }
    expect(
      (await apiQuery('select count(*)::int count from app.workflow_runs'))
        .rows,
    ).toEqual([{ count: 0 }]);
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
      deadlineAt: new Date(replay.run.createdAt.getTime() + 5_000),
    });
    expect(source.run.deadlineAt).toBeNull();
    const duplicate = await database.replay(
      replayInput(
        source.run.id,
        digest('retained-replay-request'),
        digest('retained-replay-key'),
        retainedWorkflowVersionId,
      ),
    );
    expect(duplicate.run.deadlineAt).toEqual(replay.run.deadlineAt);
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

  it('reads a run input as stored, absent, or past its 30-day window', async () => {
    const started = await database.start(startInput());
    await expect(
      database.readInput({ workspaceId, runId: started.run.id }),
    ).resolves.toEqual({
      kind: 'inline',
      value: { customerId: 'customer-42' },
    });
    await expect(
      database.readInput({
        workspaceId: otherWorkspaceId,
        runId: started.run.id,
      }),
    ).resolves.toBeUndefined();
    await expect(
      database.readInput({ workspaceId, runId: randomUUID() }),
    ).resolves.toBeUndefined();

    await ownerQuery(
      `update app.workflow_runs
       set input_ref = null, input_ref_expires_at = null
       where id = $1`,
      [started.run.id],
    );
    await expect(
      database.readInput({ workspaceId, runId: started.run.id }),
    ).resolves.toEqual({ kind: 'none' });

    await ownerQuery(
      `update app.workflow_runs
       set created_at = created_at - interval '31 days',
           updated_at = updated_at - interval '31 days'
       where id = $1`,
      [started.run.id],
    );
    await expect(
      database.readInput({ workspaceId, runId: started.run.id }),
    ).resolves.toEqual({ kind: 'expired' });
  });

  it('reads a node run output only through its own run', async () => {
    const started = await database.start(startInput());
    const other = await database.start(
      startInput(digest('request-2'), digest('key-2')),
    );
    const withOutput = randomUUID();
    const withoutOutput = randomUUID();
    await ownerQuery(
      `insert into app.node_runs
         (id,workspace_id,workflow_run_id,node_id,invocation_key,
          branch_context,status,side_effect_class,output_ref,input_ref)
       values
         ($1,$3,$4,'set-fields','set-fields','{}','succeeded','safe',$5::jsonb,
          $6::jsonb),
         ($2,$3,$4,'stop','stop','{}','pending','safe',null,null)`,
      [
        withOutput,
        withoutOutput,
        workspaceId,
        started.run.id,
        JSON.stringify({
          schemaVersion: 1,
          kind: 'inline',
          value: { report: 'daily-summary', rows: 42 },
        }),
        JSON.stringify({
          schemaVersion: 1,
          kind: 'inline',
          value: { customerId: 'customer-42' },
        }),
      ],
    );
    await expect(
      database.readNodeRunInput({
        workspaceId,
        runId: started.run.id,
        nodeRunId: withOutput,
      }),
    ).resolves.toEqual({
      kind: 'inline',
      value: { customerId: 'customer-42' },
    });
    await expect(
      database.readNodeRunInput({
        workspaceId,
        runId: started.run.id,
        nodeRunId: withoutOutput,
      }),
    ).resolves.toEqual({ kind: 'none' });

    await expect(
      database.readNodeRunOutput({
        workspaceId,
        runId: started.run.id,
        nodeRunId: withOutput,
      }),
    ).resolves.toEqual({
      kind: 'inline',
      value: { report: 'daily-summary', rows: 42 },
    });
    await expect(
      database.readNodeRunOutput({
        workspaceId,
        runId: started.run.id,
        nodeRunId: withoutOutput,
      }),
    ).resolves.toEqual({ kind: 'none' });
    await expect(
      database.readNodeRunOutput({
        workspaceId,
        runId: other.run.id,
        nodeRunId: withOutput,
      }),
    ).resolves.toBeUndefined();
    await expect(
      database.readNodeRunOutput({
        workspaceId: otherWorkspaceId,
        runId: started.run.id,
        nodeRunId: withOutput,
      }),
    ).resolves.toBeUndefined();
  });

  it('lists replay lineage and the step that explains an unsuccessful run', async () => {
    const loopVersionId = randomUUID();
    const step = (id: string, label?: string) => ({
      id,
      definition: { key: 'core.http_request', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
      ...(label === undefined ? {} : { label }),
    });
    await ownerQuery(
      `insert into app.workflow_versions
         (id, workspace_id, workflow_id, version_number, schema_version,
          graph_json, checksum, executable_schema_version, executable_json,
          compatibility_release_epoch, published_by)
       values ($1, $2, $3, 3, 1, $4::jsonb, $5, 2, $6::jsonb, 1, $7)`,
      [
        loopVersionId,
        workspaceId,
        workflowId,
        JSON.stringify({
          schemaVersion: 1,
          settings: {},
          edges: [],
          nodes: [
            {
              ...step('each-order'),
              definition: { key: 'core.for_each', version: 1 },
              structured: {
                kind: 'for_each',
                maxIterations: 10,
                maxConcurrency: 1,
                body: { nodes: [step('charge', 'Charge card')], edges: [] },
              },
            },
          ],
        }),
        `wf:v2:sha256:${'d'.repeat(64)}`,
        JSON.stringify({ schemaVersion: 2, marker: 'run-api-loop' }),
        actorId,
      ],
    );
    const source = await database.start(startInput());
    const replay = await database.replay(
      replayInput(
        source.run.id,
        digest('replay-request-1'),
        digest('replay-key-1'),
        loopVersionId,
      ),
    );
    await ownerQuery(
      `update app.workflow_runs
       set status = 'failed', started_at = created_at, completed_at = created_at
       where id = $1`,
      [replay.run.id],
    );
    await ownerQuery(
      `insert into app.node_runs
         (id,workspace_id,workflow_run_id,node_id,invocation_key,
          branch_context,status,side_effect_class,safe_error_code,
          started_at,completed_at)
       values
         (gen_random_uuid(),$1,$2,'charge','charge-0','{}','failed','safe',
          'provider.rejected', now() - interval '2 seconds', now() - interval '1 second'),
         (gen_random_uuid(),$1,$2,'charge','charge-1','{}','failed','safe',
          'provider.timeout', now(), now())`,
      [workspaceId, replay.run.id],
    );

    const page = await database.list({
      workspaceId,
      limit: 10,
      includeWorkflowName: true,
    });
    expect(page.items.find((run) => run.id === replay.run.id)).toMatchObject({
      replaySourceRunId: source.run.id,
      failedStep: {
        nodeId: 'charge',
        label: 'Charge card',
        definitionKey: 'core.http_request',
        safeErrorCode: 'provider.timeout',
      },
    });
    expect(page.items.find((run) => run.id === source.run.id)).toMatchObject({
      replaySourceRunId: null,
      failedStep: null,
    });
    await expect(
      database.get({ workspaceId, runId: replay.run.id }),
    ).resolves.toMatchObject({ run: { replaySourceRunId: source.run.id } });
  });

  it('reads each step across the workflow’s recent runs, and one step’s runs', async () => {
    const first = await database.start(startInput());
    const second = await database.start(
      startInput(digest('request-2'), digest('key-2')),
    );
    await ownerQuery(
      `insert into app.node_runs
         (id,workspace_id,workflow_run_id,node_id,invocation_key,
          branch_context,status,side_effect_class,
          safe_error_code,started_at,completed_at,created_at)
       values
         (gen_random_uuid(),$1,$2,'fetch','fetch','{}','succeeded','safe',
          null, now() - interval '10 seconds', now() - interval '9 seconds',
          now() - interval '10 seconds'),
         (gen_random_uuid(),$1,$3,'fetch','fetch','{}','succeeded','safe',
          null, now() - interval '5 seconds', now() - interval '2 seconds',
          now() - interval '5 seconds'),
         (gen_random_uuid(),$1,$3,'charge','charge','{}','failed','safe',
          'provider.timeout', now() - interval '2 seconds', now(),
          now() - interval '2 seconds')`,
      [workspaceId, first.run.id, second.run.id],
    );

    const health = await database.stepHealth({ workspaceId, workflowId });
    expect(health).toMatchObject({ runsConsidered: 2 });
    expect(health?.oldestRunAt).toBeInstanceOf(Date);
    expect(health?.items).toEqual([
      expect.objectContaining({
        nodeId: 'charge',
        runs: 1,
        succeeded: 0,
        failed: 1,
        lastStatus: 'failed',
        medianDurationMs: null,
      }),
      expect.objectContaining({
        nodeId: 'fetch',
        runs: 2,
        succeeded: 2,
        failed: 0,
        lastStatus: 'succeeded',
        medianDurationMs: 2_000,
        p95DurationMs: 2_900,
      }),
    ]);

    const charge = await database.stepRuns({
      workspaceId,
      workflowId,
      nodeId: 'charge',
      limit: 20,
    });
    expect(charge).toEqual([
      expect.objectContaining({
        runId: second.run.id,
        status: 'failed',
        attempts: 0,
        safeErrorCode: 'provider.timeout',
      }),
    ]);
    await expect(
      database.stepRuns({ workspaceId, workflowId, nodeId: 'fetch', limit: 1 }),
    ).resolves.toEqual([expect.objectContaining({ runId: second.run.id })]);
    await expect(
      database.stepRuns({ workspaceId, workflowId, nodeId: 'never', limit: 5 }),
    ).resolves.toEqual([]);
    await expect(
      database.stepHealth({ workspaceId: otherWorkspaceId, workflowId }),
    ).resolves.toBeUndefined();
    await expect(
      database.stepRuns({
        workspaceId,
        workflowId: randomUUID(),
        nodeId: 'fetch',
        limit: 5,
      }),
    ).resolves.toBeUndefined();
  });
});
