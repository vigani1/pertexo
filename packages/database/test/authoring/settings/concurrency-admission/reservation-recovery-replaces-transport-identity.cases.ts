import { readWorkflowRunReadRecord } from '../../../../src/runs/commands/records.repository.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';

import {
  apiDatabase,
  hasPostgresCode,
  workspaceA,
  workspaceB,
} from '../../../runs/acceptance/fixtures.js';
import {
  acceptRun,
  claimRuns,
  publishClaims,
  readTickets,
  setLimit,
  transitionRun,
  withOwner,
} from '../concurrency-admission.fixtures.js';

export function registerReservationRecoveryReplacesTransportIdentity(): void {
  it('reservation recovery replaces transport identity but retains ticket and capacity exactly once', async () => {
    await setLimit(1);
    const run = await acceptRun();
    await acceptRun();
    const granted = await claimRuns();
    const original = granted.events[0];
    if (original === undefined) throw new Error('Missing initial reservation');
    await publishClaims(granted);
    const tickets = await readTickets();
    await withOwner((client) =>
      client.query(
        "update app.workflow_run_active_admissions set recover_after='-infinity'::timestamptz where workflow_run_id=$1",
        [run.runId],
      ),
    );
    const recovered = await claimRuns();
    expect(recovered.events[0]?.aggregateId).toBe(run.runId);
    expect(recovered.events[0]?.id).not.toBe(original.id);
    expect(await readTickets()).toEqual(tickets);
    await publishClaims(recovered);
    await transitionRun(run.runId, 'running');
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
  });

  it('serializes concurrent grants and policy updates without deadlock or over-admission', async () => {
    await setLimit(1);
    const runs = await Promise.all(
      Array.from({ length: 8 }, () => acceptRun()),
    );
    const outcomes = await Promise.all([
      ...Array.from({ length: 4 }, () => claimRuns(1)),
      ...Array.from({ length: 4 }, () => setLimit(1)),
    ]);
    const grants = outcomes.flatMap((outcome) => outcome?.events ?? []);
    expect(grants).toHaveLength(1);
    expect(runs.some(({ runId }) => runId === grants[0]?.aggregateId)).toBe(
      true,
    );
    const tickets = await readTickets();
    expect(grants[0]?.aggregateId).toBe(tickets[0]?.id);
  });

  it('enforces shared workspace occupancy as well as each workflow cap', async () => {
    const runs = [];
    for (let index = 0; index < 6; index += 1) {
      const workflowId = randomUUID();
      await setLimit(1, workflowId);
      runs.push(
        await acceptRun({ workflowId, workflowVersionId: randomUUID() }),
      );
    }
    const claims = [];
    for (let index = 0; index < 5; index += 1) {
      const batch = await claimRuns();
      claims.push(...batch.events);
      await publishClaims(batch);
    }
    expect(claims).toHaveLength(5);
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
    const first = claims[0];
    if (first === undefined) throw new Error('Missing reserved workspace slot');
    await transitionRun(first.aggregateId, 'running');
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
    await transitionRun(first.aggregateId, 'succeeded');
    const remaining = await claimRuns();
    expect(remaining.events).toHaveLength(1);
    expect(
      runs.some(({ runId }) => runId === remaining.events[0]?.aggregateId),
    ).toBe(true);
  });

  it('keeps run reservation to the dispatcher', async () => {
    await setLimit(1);
    const run = await acceptRun();
    await expect(
      apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
      select app.reserve_workflow_run_active_admission(${workspaceA},${run.outboxEventId},${run.runId})
    `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('42501'));
  });

  it('skips an exclusively locked run before taking the counter and grants it after lock release', async () => {
    await setLimit(1);
    const run = await acceptRun();
    await withOwner(async (client) => {
      await client.query(
        'select id from app.workflow_runs where workspace_id=$1 and id=$2 for update',
        [workspaceA, run.runId],
      );
      // The pre-counter KEY SHARE SKIP LOCKED step must not wait for this
      // simulated old-worker lock while holding the workspace counter.
      await expect(claimRuns()).resolves.toMatchObject({ events: [] });
      await setLimit(1);
    });
    expect((await claimRuns()).events[0]?.aggregateId).toBe(run.runId);
  }, 5_000);

  it('uses bounded active and FIFO indexes with retained terminal history', async () => {
    await setLimit(2);
    const first = await acceptRun();
    const second = await acceptRun();
    await withOwner(async (client) => {
      // Bulk historical setup is outside the production behavior under test;
      // explicit valid tickets avoid quadratic per-insert reconciliation.
      await client.query('alter table app.workflow_runs disable trigger user');
      await client.query(
        'alter table app.workflow_runs no force row level security',
      );
      await client.query(
        `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,
          trigger_type,status,execution_entitlement_version,admission_ticket)
         select gen_random_uuid(),workspace_id,workflow_id,workflow_version_id,
          'manual','succeeded',execution_entitlement_version,
          nextval('app.workflow_run_admission_ticket_seq')
         from app.workflow_runs cross join generate_series(1,2000)
         where id=$1`,
        [first.runId],
      );
      await client.query('alter table app.workflow_runs enable trigger user');
      await client.query(
        'alter table app.workflow_runs force row level security',
      );
      await client.query('analyze app.workflow_runs');
      const run = await client.query<{
        workflow_id: string;
        admission_ticket: string;
      }>(
        'select workflow_id,admission_ticket::text from app.workflow_runs where id=$1',
        [second.runId],
      );
      const identity = run.rows[0];
      if (identity === undefined)
        throw new Error('Missing indexed fixture identity');
      const active = await client.query<{ 'QUERY PLAN': unknown }>(
        `explain (analyze,buffers,format json) select count(*) from app.workflow_runs
         where workspace_id=$1 and workflow_id=$2 and status in ('running','waiting')`,
        [workspaceA, identity.workflow_id],
      );
      const queued = await client.query<{ 'QUERY PLAN': unknown }>(
        `explain (analyze,buffers,format json) select id from app.workflow_runs
         where workspace_id=$1 and workflow_id=$2 and status='queued'
          and admission_ticket<$3`,
        [workspaceA, identity.workflow_id, identity.admission_ticket],
      );
      expect(JSON.stringify(active.rows)).toContain(
        'workflow_runs_workflow_active_idx',
      );
      expect(JSON.stringify(queued.rows)).toContain(
        'workflow_runs_queued_admission_order_idx',
      );
    });
  });

  it('projects current timestamped blockers without labeling every queued run workflow-limited', async () => {
    await setLimit(1);
    const first = await acceptRun();
    const second = await acceptRun();
    await publishClaims(await claimRuns());
    const projection = () =>
      apiDatabase.withWorkspace(
        workspaceA,
        async (transaction) =>
          (
            await readWorkflowRunReadRecord(transaction, second.runId, {
              includeWorkflowName: false,
            })
          )?.admissionBlockers ?? null,
      );
    expect(await projection()).toMatchObject({
      reasons: ['workflow_capacity', 'workflow_order'],
    });
    await transitionRun(first.runId, 'running');
    const activeBlocker = await projection();
    expect(activeBlocker?.reasons).toEqual(['workflow_capacity']);
    expect(activeBlocker?.asOf).toMatch(/\.\d{6}Z$/u);
    await setLimit(null);
    expect(await projection()).toMatchObject({ reasons: [] });
    await expect(
      apiDatabase.withWorkspace(workspaceB, (transaction) =>
        readWorkflowRunReadRecord(transaction, second.runId, {
          includeWorkflowName: false,
        }),
      ),
    ).resolves.toBeUndefined();
  });
}
