import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimOutboxBatch } from '../../../src/outbox/dispatcher/claim.js';
import { acceptWorkflowRun } from '../../../src/runs/commands/acceptance/accept.js';
import { useInstanceCapacity } from '../../support/instance-capacity.js';
import {
  acceptanceInput,
  apiDatabase,
  apiUrl,
  dispatcherDatabase,
  installExecutionAcceptanceFixture,
  migrationUrl,
  workerDatabase,
  workflowId,
  workspaceA,
  workspaceCreatorId,
} from './run-acceptance.fixture.js';

const BACKLOG = 200;

installExecutionAcceptanceFixture();
describe('run admission under a backlog', () => {
  useInstanceCapacity(
    { activeRunLimit: 5, queuedRunLimit: 1_000, artifactCountLimit: 1_000 },
    apiUrl,
  );

  // A superuser session that switches to the dispatcher's role, so it can count
  // the eligibility checks one claim makes.
  let dispatcher: Pool;
  beforeAll(async () => {
    const adminUrl = new URL(
      process.env.DATABASE_ADMIN_URL ??
        'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
    );
    adminUrl.pathname = new URL(migrationUrl).pathname;
    dispatcher = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    const client = await dispatcher.connect();
    try {
      await client.query("set track_functions='all'");
      await client.query('set role pertexo_maintenance');
    } finally {
      client.release();
    }
  });
  afterAll(() => dispatcher.end());

  it('checks only the head of a limited queue, however long the queue is', async () => {
    await limitFixtureWorkflow(1);
    const runIds = await acceptRuns(BACKLOG);

    const first = await claim();
    expect(first.events.map((event) => event.aggregateId)).toEqual([runIds[0]]);

    const checks = await eligibilityChecks(async () => {
      expect((await claim()).events).toEqual([]);
    });
    // The head is the only run the limit could let in next.
    expect(checks).toBeLessThanOrEqual(1);

    await finishRun(runIds[0]);
    const next = await claim();
    expect(next.events.map((event) => event.aggregateId)).toEqual([runIds[1]]);
  }, 120_000);

  it('checks no queued run while every workspace slot is taken', async () => {
    const runIds = await acceptRuns(BACKLOG);

    const admitted = await claim();
    expect(admitted.events.map((event) => event.aggregateId)).toEqual(
      runIds.slice(0, 5),
    );

    const checks = await eligibilityChecks(async () => {
      expect((await claim()).events).toEqual([]);
    });
    expect(checks).toBe(0);

    await finishRun(runIds[0]);
    const next = await claim();
    expect(next.events.map((event) => event.aggregateId)).toEqual([runIds[5]]);
  }, 120_000);

  async function claim() {
    const batch = await claimOutboxBatch(dispatcher, {
      enabledJobNames: ['advance-workflow-run'],
      leaseDurationMillis: 30_000,
      leaseOwner: 'admission-backlog-test',
      leaseToken: randomUUID(),
      limit: 25,
    });
    // Published, as the dispatcher would, so a later claim sees only the queue.
    for (const event of batch.events)
      await expect(
        dispatcherDatabase.markPublished(event.id, event.leaseToken),
      ).resolves.toBe(true);
    return batch;
  }

  async function eligibilityChecks(action: () => Promise<void>) {
    const before = await eligibilityCallCount();
    await action();
    return (await eligibilityCallCount()) - before;
  }

  async function eligibilityCallCount(): Promise<number> {
    // The flush runs when this session next goes idle, before it reads the count.
    await dispatcher.query('select pg_stat_force_next_flush()');
    await dispatcher.query('select pg_stat_clear_snapshot()');
    const result = await dispatcher.query<{ calls: string }>(
      `select coalesce(sum(calls),0)::text calls from pg_stat_user_functions
        where schemaname='app' and funcname='workflow_run_active_admission_eligible'`,
    );
    return Number(result.rows[0]?.calls);
  }
});

async function acceptRuns(count: number): Promise<string[]> {
  const runIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const hash = (value: string) =>
      createHash('sha256')
        .update(`${value}-${String(index)}`)
        .digest('hex');
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(hash('backlog-request')),
          keyHash: hash('backlog-key'),
          scope: `backlog:${String(index)}`,
        }),
    );
    runIds.push(accepted.runId);
  }
  return runIds;
}

async function limitFixtureWorkflow(activeRunLimit: number): Promise<void> {
  const owner = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await owner.query('begin');
    await owner.query('set local role pertexo_owner');
    await owner.query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Backlog',$3)",
      [workflowId, workspaceA, workspaceCreatorId],
    );
    await owner.query(
      'insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit) values($1,$2,$3)',
      [workspaceA, workflowId, activeRunLimit],
    );
    await owner.query('commit');
  } finally {
    await owner.query('rollback').catch(() => undefined);
    await owner.end();
  }
}

async function finishRun(runId: string | undefined): Promise<void> {
  if (runId === undefined) throw new Error('Expected a run to finish');
  for (const status of ['running', 'succeeded'])
    await workerDatabase.withWorkspace(workspaceA, async ({ db }) => {
      await db.execute(
        sql`select set_config('app.workflow_concurrency_protocol','1',true)`,
      );
      await db.execute(sql`
        update app.workflow_runs set status=${status}
         where workspace_id=${workspaceA} and id=${runId}
      `);
    });
}
