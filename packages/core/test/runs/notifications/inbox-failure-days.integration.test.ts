import { expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { databaseSchema } from '@pertexo/database/schema';
import { recordInboxFailureDay } from '../../../src/inbox/failure-days.repository.js';
import { readFailureDays } from '../../../src/inbox/threads/failure-days.repository.js';
import { purgeRunLeaves } from '../../../src/lifecycle/purge/links.repository.js';
import {
  asAdmin,
  asRuntime,
  checkpoint,
  insertRun,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../run-store/run-store.fixture.js';

it('records a terminal failure once, reads its daily history without scanning runs, and removes deleted contributions', async () => {
  const runId = await insertRun({});
  const occurredAt = new Date().toISOString();
  const input = {
    workspaceId: workspaceA,
    runId,
    workflowVersionId: versionA,
    signal: new AbortController().signal,
    plan: {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'failed',
        nextEventSequence: 3,
        invocations: [],
      }),
      events: [
        {
          sequence: 2,
          name: 'run.failed' as const,
          occurredAt,
          reasonCode: 'callable_result_invalid',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    },
  };
  const stored = () =>
    asAdmin(
      async (pool) =>
        (
          await pool.query<Record<string, unknown>>(
            `select
    (select to_jsonb(r) from app.workflow_runs r where id=$1) run,
    (select to_jsonb(c) from app.run_checkpoints c where workflow_run_id=$1) checkpoint,
    (select jsonb_agg(e order by sequence) from app.run_events e where workflow_run_id=$1) events,
    (select jsonb_agg(e) from app.workspace_inbox_events e where run_id=$1) inbox,
    (select jsonb_agg(d) from app.workspace_inbox_failure_days d where workflow_id=(select workflow_id from app.workflow_runs where id=$1)) days`,
            [runId],
          )
        ).rows,
    );
  const before = await stored();
  await asAdmin((pool) =>
    pool.query(
      "alter table app.workspace_inbox_events add constraint reject_terminal_producer check (kind <> 'failed') not valid",
    ),
  );
  try {
    await expect(ownedDeliveryStore.commitAdvancePlan(input)).rejects.toThrow();
    expect(await stored()).toEqual(before);
  } finally {
    await asAdmin((pool) =>
      pool.query(
        'alter table app.workspace_inbox_events drop constraint reject_terminal_producer',
      ),
    );
  }
  await expect(
    ownedDeliveryStore.commitAdvancePlan(input),
  ).resolves.toMatchObject({ kind: 'committed' });
  await expect(
    ownedDeliveryStore.commitAdvancePlan(input),
  ).resolves.toMatchObject({ kind: 'already_committed' });
  await asAdmin(async (pool) => {
    const events = await pool.query(
      'select kind,terminal_event_sequence,occurred_at from app.workspace_inbox_events where run_id=$1',
      [runId],
    );
    expect(events.rows).toEqual([
      {
        kind: 'failed',
        terminal_event_sequence: '2',
        occurred_at: new Date(occurredAt),
      },
    ]);
  });
  const {
    rows: [run],
  } = await asAdmin((pool) =>
    pool.query<{ workflow_id: string }>(
      'select workflow_id from app.workflow_runs where id=$1',
      [runId],
    ),
  );
  if (run === undefined) throw new Error('Run missing');
  const day = occurredAt.slice(0, 10);
  const read = () =>
    asRuntime(workerBaseUrl, workspaceA, (client) =>
      readFailureDays(drizzle(client, { schema: databaseSchema }), workspaceA, [
        run.workflow_id,
      ]),
    );
  expect(await read()).toEqual(
    new Map([[run.workflow_id, [{ day, count: 1 }]]]),
  );
  for (const count of [1, 50_000, 100_000]) {
    await asAdmin((pool) =>
      pool.query(
        'update app.workspace_inbox_failure_days set count=$2 where workflow_id=$1',
        [run.workflow_id, count],
      ),
    );
    const statements: { query: string; params: unknown[] }[] = [];
    const history = await asRuntime(
      workerBaseUrl,
      workspaceA,
      async (client) => {
        const db = drizzle(client, {
          schema: databaseSchema,
          logger: {
            logQuery: (query, params) => {
              statements.push({ query, params });
            },
          },
        });
        const result = await readFailureDays(db, workspaceA, [run.workflow_id]);
        const statement = statements[0];
        if (statement === undefined) throw new Error('History query missing');
        interface Plan {
          'Actual Rows': number;
          'Shared Hit Blocks': number;
          'Shared Read Blocks': number;
        }
        const explained = await client.query<{
          'QUERY PLAN': { Plan: Plan }[];
        }>(
          `explain (analyze,buffers,format json) ${statement.query}`,
          statement.params,
        );
        const plan = explained.rows[0]?.['QUERY PLAN'][0]?.Plan;
        if (plan === undefined) throw new Error('History plan missing');
        expect(plan['Actual Rows']).toBeLessThanOrEqual(30);
        expect(
          plan['Shared Hit Blocks'] + plan['Shared Read Blocks'],
        ).toBeLessThanOrEqual(32);
        return result;
      },
    );
    expect(history).toEqual(new Map([[run.workflow_id, [{ day, count }]]]));
  }
  await asAdmin((pool) =>
    pool.query(
      'update app.workspace_inbox_failure_days set count=1 where workflow_id=$1',
      [run.workflow_id],
    ),
  );
  await asAdmin((pool) =>
    pool.query('revoke select on app.workflow_runs from pertexo_app'),
  );
  try {
    expect(await read()).toEqual(
      new Map([[run.workflow_id, [{ day, count: 1 }]]]),
    );
  } finally {
    await asAdmin((pool) =>
      pool.query('grant select on app.workflow_runs to pertexo_app'),
    );
  }
  await asRuntime(workerBaseUrl, workspaceA, async (client) => {
    await client.query('savepoint failed_increment');
    await recordInboxFailureDay(client, {
      workspaceId: workspaceA,
      workflowId: run.workflow_id,
      completedAt: occurredAt,
    });
    await client.query('rollback to savepoint failed_increment');
  });
  expect(await read()).toEqual(
    new Map([[run.workflow_id, [{ day, count: 1 }]]]),
  );
  await asRuntime(
    process.env.DATABASE_MAINTENANCE_URL ?? '',
    workspaceA,
    (client) => purgeRunLeaves(client, workspaceA, 100),
  );
  expect(await read()).toEqual(new Map());
});
