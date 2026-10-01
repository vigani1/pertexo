import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { expect } from 'vitest';
import { migrateDatabase } from '../src/migrations.js';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import { checkDispatcherReadiness } from '../src/execution/transport/dispatcher-readiness.js';
import { createWorkflowAuthoringDatabase } from '../src/authoring/workflow-authoring.js';
import type { WorkflowConcurrencyDatabase } from '../src/authoring/workflow-concurrency.js';
import { parseDatabaseConfig } from '../src/config.js';
import { acceptWorkflowRun } from '../src/execution/runs/execution-acceptance.js';
import {
  acceptanceInput,
  apiDatabase,
  apiUrl,
  dispatcherDatabase,
  migrationUrl,
  workerDatabase,
  workspaceA,
  workspaceCreatorId,
  workflowId,
} from './execution-acceptance.fixtures.js';
import {
  copyMigrationsBefore,
  createArtifactMigrationConfig,
} from './support/artifact-migration-fixture.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

export async function setLimit(limit: number | null, id = workflowId) {
  await withOwner(async (client) => {
    await client.query('select id from app.workspaces where id=$1 for share', [
      workspaceA,
    ]);
    await client.query('alter table app.workflows no force row level security');
    await client.query(
      `insert into app.workflows(id,workspace_id,name,created_by)
       values($1,$2,'Concurrency proof',$3) on conflict(id) do nothing`,
      [id, workspaceA, workspaceCreatorId],
    );
    await client.query('alter table app.workflows force row level security');
    // Setup uses the same authoritative serialization as the command owner.
    await client.query(
      'select 1 from app.workspace_execution_admission_counters where workspace_id=$1 for update',
      [workspaceA],
    );
    await client.query(
      `insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit)
       values($1,$2,$3) on conflict(workspace_id,workflow_id) do update
       set active_run_limit=excluded.active_run_limit,revision=app.workflow_concurrency_policies.revision+1`,
      [workspaceA, id, limit],
    );
  });
}

export async function withConcurrencyControls<T>(
  operation: (
    controls: WorkflowConcurrencyDatabase,
    scope: { workspaceId: string; workflowId: string; actorId: string },
  ) => Promise<T>,
) {
  await setLimit(null);
  await withOwner(async (client) => {
    await client.query(
      'alter table app.workspace_memberships no force row level security',
    );
    await client.query(
      `insert into app.workspace_memberships(workspace_id,user_id,role,status)
      values($1,$2,'owner','active') on conflict(workspace_id,user_id) do update set role='owner',status='active'`,
      [workspaceA, workspaceCreatorId],
    );
    await client.query(
      'alter table app.workspace_memberships force row level security',
    );
  });
  const authoring = createWorkflowAuthoringDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
  );
  try {
    if (authoring.concurrency === undefined)
      throw new Error('Missing concurrency store');
    return await operation(authoring.concurrency, {
      workspaceId: workspaceA,
      workflowId,
      actorId: workspaceCreatorId,
    });
  } finally {
    await authoring.close();
  }
}

export async function withOwner<T>(
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function withDispatcher<T>(
  operation: (client: PoolClient) => Promise<T>,
  protocol = true,
) {
  const url = new URL(
    process.env.DATABASE_DISPATCHER_URL ??
      'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo',
  );
  url.pathname = new URL(migrationUrl).pathname;
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceA,
    ]);
    if (protocol)
      await client.query(
        "select set_config('app.workflow_concurrency_protocol','1',true)",
      );
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function reapConcurrencyReceipts(limit: number) {
  const url = new URL(process.env.DATABASE_MAINTENANCE_URL ?? migrationUrl);
  if (process.env.DATABASE_MAINTENANCE_URL === undefined) {
    url.username = 'pertexo_maintenance';
    url.password = 'pertexo-local-maintenance';
  }
  url.pathname = new URL(migrationUrl).pathname;
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    return (
      await pool.query<{ idempotency_records_deleted: number }>(
        'select * from app.reap_transient_data($1)',
        [limit],
      )
    ).rows[0]?.idempotency_records_deleted;
  } finally {
    await pool.end();
  }
}

export async function acceptRun(
  input: {
    workflowId?: string;
    workflowVersionId?: string;
    deadlineAt?: Date;
  } = {},
) {
  const identity = randomUUID();
  const hash = createHash('sha256').update(identity).digest('hex');
  const request = {
    ...acceptanceInput(hash),
    ...input,
    initialCheckpoint: {
      ...acceptanceInput(hash).initialCheckpoint,
      ...(input.workflowVersionId === undefined
        ? {}
        : { workflowVersionId: input.workflowVersionId }),
    },
    keyHash: hash,
    scope: `concurrency:${identity}`,
  };
  const result = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
    acceptWorkflowRun(transaction, request),
  );
  return { ...result, request };
}

export function claimRuns(limit = 10) {
  return dispatcherDatabase.claimBatch({
    enabledJobNames: ['advance-workflow-run'],
    leaseDurationMillis: 30_000,
    leaseOwner: 'workflow-concurrency-proof',
    leaseToken: randomUUID(),
    limit,
    maxAttempts: 3,
  });
}

export async function transitionRun(
  runId: string,
  status: 'running' | 'waiting' | 'succeeded' | 'canceled' | 'failed',
  protocol = true,
) {
  return workerDatabase.withWorkspace(workspaceA, async ({ db }) => {
    if (protocol)
      await db.execute(
        sql`select set_config('app.workflow_concurrency_protocol','1',true)`,
      );
    await db.execute(sql`
      update app.workflow_runs set status=${status}
       where workspace_id=${workspaceA} and id=${runId}
    `);
  });
}

export async function readTickets() {
  return withOwner(
    async (client) =>
      (
        await client.query<{ id: string; ticket: string }>(
          `select id,admission_ticket::text ticket from app.workflow_runs
        where workspace_id=$1 order by admission_ticket`,
          [workspaceA],
        )
      ).rows,
  );
}

export async function publishClaims(
  batch: Awaited<ReturnType<typeof claimRuns>>,
) {
  for (const event of batch.events) {
    if (!(await dispatcherDatabase.markPublished(event.id, event.leaseToken)))
      throw new Error('Fixture could not publish claimed delivery');
  }
}

export async function proveLegacyConcurrencyUpgrade() {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const apiBase =
    process.env.DATABASE_API_URL ??
    'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
  const migrationBase =
    process.env.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    databaseName: `pertexo_test_conc_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
    connectRoles: [
      'pertexo_migration',
      'pertexo_api',
      'pertexo_worker',
      'pertexo_dispatcher',
    ],
  });
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-concurrency-0126-'),
  );
  const owner = new Pool({
    connectionString: fixture.databaseUrl(adminUrl),
    max: 1,
  });
  const api = new Pool({
    connectionString: fixture.databaseUrl(apiBase),
    max: 1,
  });
  const worker = new Pool({
    connectionString: fixture.databaseUrl(
      process.env.DATABASE_WORKER_URL ??
        'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo',
    ),
    max: 1,
  });
  const dispatcher = new Pool({
    connectionString: fixture.databaseUrl(
      process.env.DATABASE_DISPATCHER_URL ??
        'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo',
    ),
    max: 1,
  });
  let cleanup: PromiseSettledResult<void>[] = [];
  try {
    await fixture.create();
    await copyMigrationsBefore(directory, '0127_');
    const config = createArtifactMigrationConfig(
      fixture.databaseUrl(migrationBase),
    );
    expect((await migrateDatabase(config, directory)).at(-1)).toBe(
      '0126_workspace_usage_capacity.sql',
    );
    const legacy = await seedLegacyConcurrencyRuns(owner);
    await expect(
      checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
    ).rejects.toThrow();
    expect(await migrateDatabase(config)).toEqual([
      '0127_workflow_concurrency.sql',
    ]);
    expect(await migrateDatabase(config)).toEqual([]);
    const tickets = await owner.query<{ id: string; ticket: string }>(
      'select id,admission_ticket::text ticket from app.workflow_runs order by admission_ticket',
    );
    expect(tickets.rows).toEqual([
      { id: legacy.first, ticket: '1' },
      { id: legacy.second, ticket: '2' },
    ]);
    expect(
      (
        await owner.query<{ exempt: boolean }>(
          'select workflow_concurrency_order_exempt exempt from app.workflow_run_active_admissions',
        )
      ).rows,
    ).toEqual([{ exempt: true }]);
    await expect(
      checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
    ).resolves.toMatchObject({
      migrationHead: '0127_workflow_concurrency.sql',
    });
    await proveConcurrencyReadinessTamper(owner, api, worker, dispatcher);
  } finally {
    cleanup = await Promise.allSettled([
      owner.end(),
      api.end(),
      worker.end(),
      dispatcher.end(),
    ]);
    await fixture.drop();
    await rm(directory, { recursive: true, force: true });
  }
  const failed = cleanup.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

async function seedLegacyConcurrencyRuns(owner: Pool) {
  const actor = randomUUID(),
    workspace = randomUUID(),
    workflow = randomUUID();
  const first = randomUUID(),
    second = randomUUID(),
    event = randomUUID();
  await owner.query(
    "insert into app.users(id,email,display_name,status) values($1,$2,'Owner','active')",
    [actor, `${actor}@example.test`],
  );
  await owner.query(
    "insert into app.workspaces(id,name,slug,status,created_by) values($1,'Legacy concurrency',$2,'active',$3)",
    [workspace, `legacy-${workspace}`, actor],
  );
  await owner.query(
    "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Legacy FIFO',$3)",
    [workflow, workspace, actor],
  );
  for (const [id, offset] of [
    [first, 2],
    [second, 1],
  ] as const) {
    await owner.query(
      `with tenant as(select set_config('app.workspace_id',$2::uuid::text,true))
      insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,created_at)
      select $1::uuid,$2::uuid,$3::uuid,$4::uuid,'manual','queued',clock_timestamp()-$5::int*interval '1 second' from tenant`,
      [id, workspace, workflow, randomUUID(), offset],
    );
  }
  await owner.query(
    `insert into app.outbox_events(id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,payload,payload_checksum)
    values($1,$2,'advance-workflow-run',1,'workflow-run',$3,'{}'::jsonb,$4)`,
    [event, workspace, first, '0'.repeat(64)],
  );
  await owner.query(
    'insert into app.workflow_run_active_admissions(workspace_id,workflow_run_id,outbox_event_id) values($1,$2,$3)',
    [workspace, first, event],
  );
  return { first, second };
}

async function proveConcurrencyReadinessTamper(
  owner: Pool,
  api: Pool,
  worker: Pool,
  dispatcher: Pool,
) {
  for (const signature of [
    'app.workflow_concurrency_admissible(uuid,uuid,boolean)',
    'app.rebind_workflow_run_active_admission(uuid,uuid,uuid,uuid)',
  ]) {
    const row = (
      await owner.query<{ definition: string }>(
        'select pg_get_functiondef($1::regprocedure) definition',
        [signature],
      )
    ).rows[0];
    if (row === undefined)
      throw new Error('Missing concurrency function definition');
    const modified = row.definition.replace(
      'BEGIN\n',
      'BEGIN\n  -- readiness body fingerprint mutation\n',
    );
    if (modified === row.definition)
      throw new Error('Missing function mutation seam');
    await owner.query(modified);
    try {
      await assertConcurrencyReadiness(api, worker, dispatcher, false);
    } finally {
      await owner.query(row.definition);
    }
    await assertConcurrencyReadiness(api, worker, dispatcher, true);
  }
  for (const [modify, restore] of [
    [
      'grant execute on function app.rebind_workflow_run_active_admission(uuid,uuid,uuid,uuid) to pertexo_api',
      'revoke execute on function app.rebind_workflow_run_active_admission(uuid,uuid,uuid,uuid) from pertexo_api',
    ],
    [
      'grant select on app.workflow_concurrency_policies to pertexo_api',
      'revoke select on app.workflow_concurrency_policies from pertexo_api',
    ],
    [
      'alter index app.workflow_runs_queued_admission_order_idx rename to concurrency_index_drift',
      'alter index app.concurrency_index_drift rename to workflow_runs_queued_admission_order_idx',
    ],
    [
      'grant usage on sequence app.workflow_run_admission_ticket_seq to pertexo_worker',
      'revoke usage on sequence app.workflow_run_admission_ticket_seq from pertexo_worker',
    ],
  ] as const) {
    await owner.query(modify);
    try {
      await assertConcurrencyReadiness(api, worker, dispatcher, false);
    } finally {
      await owner.query(restore);
    }
    await assertConcurrencyReadiness(api, worker, dispatcher, true);
  }
}

async function assertConcurrencyReadiness(
  api: Pool,
  worker: Pool,
  dispatcher: Pool,
  ready: boolean,
) {
  const probes = [
    checkDatabaseReadiness(api, { ownerRole: 'pertexo_owner' }),
    checkDatabaseReadiness(worker, {
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    }),
    checkDispatcherReadiness(dispatcher, 'pertexo_owner'),
  ];
  await Promise.all(
    probes.map(async (probe) => {
      if (ready) await probe;
      else await expect(probe).rejects.toThrow();
    }),
  );
}
