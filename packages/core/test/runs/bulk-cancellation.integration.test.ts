import { lockRunAcceptanceCommand } from '../../src/testing.js';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createCheckpoint } from '@pertexo/workflow-engine/server';
import { databaseSchema } from '@pertexo/database/testing';
import { parseWorkspaceId } from '@pertexo/database/primitives';
import { requestActiveRunCancellations } from '../../src/runs/commands/cancel-run.js';
import {
  actorId,
  apiBaseUrl,
  asAdmin,
  asOwner,
  asRuntime,
  workspaceA,
  workflowA,
  versionA,
} from './run-store/run-store.fixture.js';

async function seedRuns(population: number) {
  await asOwner(workspaceA, (client) =>
    client.query('select app.apply_instance_capacity(10000,100000,1000)'),
  );
  return asRuntime(apiBaseUrl, workspaceA, async (client) => {
    await lockRunAcceptanceCommand(
      {
        db: drizzle(client, { schema: databaseSchema }),
        workspaceId: parseWorkspaceId(workspaceA),
      },
      {
        scope: `workflow:${workflowA}:manual`,
        idempotencyKeyHash: 'a'.repeat(64),
      },
    );
    const inserted = await client.query<{ id: string }>(
      `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,status,trigger_type,started_at)
      select gen_random_uuid(),$1,$2,$3,case when n%2=0 then 'queued' else 'running' end,'manual',clock_timestamp()
      from generate_series(1,$4) n returning id`,
      [workspaceA, workflowA, versionA, population],
    );
    const checkpoint = createCheckpoint({
      workflowVersionId: versionA,
      iterationBudget: 200,
      nextEventSequence: 1,
    });
    await client.query(
      `insert into app.run_checkpoints(workspace_id,workflow_run_id,workflow_version_id,revision,scheduler_state)
      select workspace_id,id,workflow_version_id,0,jsonb_set($2::jsonb,'{runStatus}',to_jsonb(status::text)) from app.workflow_runs where id=any($1::uuid[])`,
      [inserted.rows.map((row) => row.id), JSON.stringify(checkpoint)],
    );
    return inserted.rows.map((row) => row.id).sort();
  });
}
async function cancelAll() {
  let queries = 0;
  return asRuntime(apiBaseUrl, workspaceA, async (client) => {
    const db = drizzle(client, {
      schema: databaseSchema,
      logger: {
        logQuery: () => {
          queries += 1;
        },
      },
    });
    await db.execute(
      sql`select id from app.workspaces where id=${workspaceA} for update`,
    );
    const start = performance.now();
    const count = await requestActiveRunCancellations(
      { db, workspaceId: parseWorkspaceId(workspaceA) },
      { actorId, reason: 'Workspace deletion' },
    );
    return { count, queries, lockedMs: performance.now() - start };
  });
}
async function facts(ids: string[]) {
  return asAdmin((client) =>
    client.query(
      `select
    (select count(*)::int from app.workflow_runs where id=any($1::uuid[]) and cancel_requested_at is not null and cancel_requested_by=$2::text and cancel_reason='Workspace deletion') requested,
    (select count(*)::int from app.run_events where workflow_run_id=any($1::uuid[]) and type='run.cancel_requested' and payload->>'actor'=$2::text and payload->>'reason'='Workspace deletion') events,
    (select count(*)::int from app.outbox_events where aggregate_id=any($1::uuid[]) and job_name='advance-workflow-run') wakeups,
    (select count(*)::int from app.audit_events where target_id=any($1::uuid[]) and action='workflow.run.cancel_requested' and metadata->>'reasonProvided'='true') audits`,
      [ids, actorId],
    ),
  );
}
describe('atomic workspace run cancellation', () => {
  it('requests every run with one event, wakeup and audit while bounding database round trips', async () => {
    const ids = await seedRuns(2000);
    const measured = await cancelAll();
    expect(measured.count).toBe(ids.length);
    expect((await facts(ids)).rows).toEqual([
      { requested: 2000, events: 2000, wakeups: 2000, audits: 2000 },
    ]);
    expect((await cancelAll()).count).toBe(0);
    expect((await facts(ids)).rows).toEqual([
      { requested: 2000, events: 2000, wakeups: 2000, audits: 2000 },
    ]);
    console.info(
      `C4_BULK_CANCELLATION=${JSON.stringify({ population: ids.length, ...measured })}`,
    );
    // The budget supplements the saved-row proof: one trip per run holds the
    // workspace lock for seconds even when the database is local.
    expect(measured.queries).toBeLessThanOrEqual(24);
  }, 60_000);
  it('rolls back earlier cancellation batches when a later audit cannot commit', async () => {
    const ids = await seedRuns(750);
    const lastId = ids.at(-1);
    if (lastId === undefined) throw new Error('No seeded run');
    await asAdmin((client) =>
      client.query(`create function public.refuse_bulk_cancel_audit() returns trigger language plpgsql as $$ begin
      if NEW.target_id='${lastId}'::uuid and NEW.action='workflow.run.cancel_requested' then raise exception 'Audit unavailable'; end if; return NEW; end $$;
      create trigger refuse_bulk_cancel_audit before insert on app.audit_events for each row execute function public.refuse_bulk_cancel_audit()`),
    );
    try {
      await expect(cancelAll()).rejects.toMatchObject({ code: 'P0001' });
      expect((await facts(ids)).rows).toEqual([
        { requested: 0, events: 0, wakeups: 0, audits: 0 },
      ]);
    } finally {
      await asAdmin((client) =>
        client.query(
          'drop trigger refuse_bulk_cancel_audit on app.audit_events; drop function public.refuse_bulk_cancel_audit()',
        ),
      );
    }
    expect((await cancelAll()).count).toBe(750);
    expect((await facts(ids)).rows).toEqual([
      { requested: 750, events: 750, wakeups: 750, audits: 750 },
    ]);
  }, 60_000);
});
