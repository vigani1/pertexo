import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { createWorkflowAuthoringDatabase } from '../../../src/authoring/workflows/database.js';
import type { WorkflowConcurrencyDatabase } from '../../../src/authoring/settings/concurrency.js';
import { parseDatabaseConfig } from '../../../src/config.js';
import { acceptWorkflowRun } from '../../../src/runs/commands/acceptance.js';
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
} from '../../runs/acceptance/acceptance.fixtures.js';
import { enforceRetention } from '../../support/retention.js';
import { testExecutableCompiler } from '../../../src/authoring/test-executable-compiler.js';

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
    { executableCompiler: testExecutableCompiler },
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
    process.env.DATABASE_MAINTENANCE_URL ??
      'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
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

/** Runs retention and returns how many idempotency records it removed. */
export async function reapConcurrencyReceipts() {
  const url = new URL(process.env.DATABASE_MAINTENANCE_URL ?? migrationUrl);
  if (process.env.DATABASE_MAINTENANCE_URL === undefined) {
    url.username = 'pertexo_maintenance';
    url.password = 'pertexo-local-maintenance';
  }
  url.pathname = new URL(migrationUrl).pathname;
  return (await enforceRetention(url.toString())).idempotency_records;
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
