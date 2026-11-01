import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { acceptWorkflowRun } from '../../../../src/runs/commands/acceptance.repository.js';
import {
  apiDatabase,
  hasPostgresCode,
  workerDatabase,
  workspaceA,
} from '../../../runs/acceptance/fixtures.js';
import {
  acceptRun,
  claimRuns,
  publishClaims,
  readTickets,
  setLimit,
  transitionRun,
  withDispatcher,
  withOwner,
} from '../concurrency-admission.fixtures.js';

export function registerPersistsAcceptanceTicketsOnceExact(): void {
  it('persists acceptance tickets once for exact replay and preserves gaps after rollback', async () => {
    const first = await acceptRun();
    const before = await readTickets();
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, first.request),
      ),
    ).resolves.toMatchObject({ runId: first.runId });
    expect(await readTickets()).toEqual(before);
    let rolledBackId: string | undefined;
    await expect(
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        const result = await acceptWorkflowRun(transaction, {
          ...first.request,
          scope: `rollback:${randomUUID()}`,
        });
        rolledBackId = result.runId;
        throw new Error('Intentional admission transaction rollback');
      }),
    ).rejects.toThrow('Intentional admission transaction rollback');
    const second = await acceptRun();
    const tickets = await readTickets();
    expect(tickets.map(({ id }) => id)).toEqual([first.runId, second.runId]);
    expect(tickets.some(({ id }) => id === rolledBackId)).toBe(false);
    const [firstTicket, secondTicket] = tickets;
    if (firstTicket === undefined || secondTicket === undefined)
      throw new Error('Missing committed acceptance tickets');
    expect(BigInt(secondTicket.ticket)).toBeGreaterThan(
      BigInt(firstTicket.ticket),
    );
  });

  it('cap one reserves only the oldest run, counts waits, and releases at terminalization', async () => {
    await setLimit(1);
    const first = await acceptRun();
    const second = await acceptRun();
    const granted = await claimRuns();
    expect(granted.events.map(({ aggregateId }) => aggregateId)).toEqual([
      first.runId,
    ]);
    await publishClaims(granted);
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
    await transitionRun(first.runId, 'waiting');
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
    await transitionRun(first.runId, 'running');
    await transitionRun(first.runId, 'succeeded');
    expect(
      (await claimRuns()).events.map(({ aggregateId }) => aggregateId),
    ).toEqual([second.runId]);
  });

  it('cap two refuses reversed first-start delivery without consuming a second slot', async () => {
    await setLimit(2);
    const first = await acceptRun();
    const second = await acceptRun();
    const firstGrant = await claimRuns();
    await publishClaims(firstGrant);
    const secondGrant = await claimRuns();
    expect(firstGrant.events[0]?.aggregateId).toBe(first.runId);
    expect(secondGrant.events[0]?.aggregateId).toBe(second.runId);
    await publishClaims(secondGrant);
    await expect(transitionRun(second.runId, 'running')).rejects.toSatisfy(
      hasPostgresCode('PTC02'),
    );
    await transitionRun(first.runId, 'running');
    await transitionRun(second.runId, 'running');
    expect(
      await withOwner(
        async (client) =>
          (
            await client.query<{ n: number }>(
              'select * from app.workflow_run_active_admissions',
            )
          ).rowCount,
      ),
    ).toBe(0);
  });

  it('grandfathers committed reservations when lowering a cap and stops new grants', async () => {
    await setLimit(2);
    const first = await acceptRun();
    const second = await acceptRun();
    const third = await acceptRun();
    const one = await claimRuns();
    await publishClaims(one);
    const two = await claimRuns();
    await publishClaims(two);
    await setLimit(1);
    await transitionRun(first.runId, 'running');
    await transitionRun(second.runId, 'running');
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
    await transitionRun(first.runId, 'succeeded');
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
    await setLimit(null);
    expect((await claimRuns()).events[0]?.aggregateId).toBe(third.runId);
  });

  it('enabling a cap does not revoke or reorder null-cap committed reservations', async () => {
    const first = await acceptRun();
    const second = await acceptRun();
    await publishClaims(await claimRuns());
    await publishClaims(await claimRuns());
    await setLimit(1);
    await transitionRun(second.runId, 'running');
    await transitionRun(first.runId, 'running');
    expect(
      await withOwner(
        async (client) =>
          (
            await client.query<{ n: number }>(
              "select count(*)::integer n from app.workflow_runs where status='running'",
            )
          ).rows[0]?.n,
      ),
    ).toBe(2);
  });

  it('uses one current cap across published-version identities and lets unrelated workflows progress', async () => {
    await setLimit(1);
    const first = await acceptRun();
    const blocked = await acceptRun({ workflowVersionId: randomUUID() });
    const otherWorkflow = randomUUID();
    const unrelated = await acceptRun({
      workflowId: otherWorkflow,
      workflowVersionId: randomUUID(),
    });
    await publishClaims(await claimRuns());
    await transitionRun(first.runId, 'running');
    const batch = await claimRuns();
    expect(batch.events.map(({ aggregateId }) => aggregateId)).toEqual([
      unrelated.runId,
    ]);
    expect(
      batch.events.some(({ aggregateId }) => aggregateId === blocked.runId),
    ).toBe(false);
  });

  it('fails closed for an old worker helper and direct queued-to-active writer', async () => {
    await setLimit(1);
    const run = await acceptRun();
    expect(
      await withDispatcher(
        async (client) =>
          (
            await client.query<{ allowed: boolean }>(
              'select app.reserve_workflow_run_active_admission($1,$2,$3) allowed',
              [workspaceA, run.outboxEventId, run.runId],
            )
          ).rows[0]?.allowed,
        false,
      ),
    ).toBe(false);
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
      select app.workflow_run_active_capacity_available(${workspaceA},1,${run.runId})
    `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('PTC01'));
    await expect(transitionRun(run.runId, 'running', false)).rejects.toSatisfy(
      hasPostgresCode('PTC01'),
    );
    await publishClaims(await claimRuns());
    await transitionRun(run.runId, 'running');
  });

  it('delivers queued cancellation and deadline terminalization despite full capacity and FIFO', async () => {
    await setLimit(1);
    const active = await acceptRun();
    await publishClaims(await claimRuns());
    await transitionRun(active.runId, 'running');
    await acceptRun(); // Earlier queued work must not hold terminal controls hostage.
    const cancelled = await acceptRun();
    const expired = await acceptRun({
      deadlineAt: new Date(Date.now() + 1_000),
    });
    await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
      update app.workflow_runs set cancel_requested_at=clock_timestamp(),cancel_requested_by='concurrency-test'
       where workspace_id=${workspaceA} and id=${cancelled.runId}
    `),
    );
    await withOwner((client) =>
      client.query(
        `select pg_sleep(greatest(0,extract(epoch from(deadline_at-clock_timestamp()))+0.001))
       from app.workflow_runs where id=$1`,
        [expired.runId],
      ),
    );
    const controls = [];
    for (let index = 0; index < 2; index += 1) {
      const batch = await claimRuns();
      controls.push(...batch.events.map(({ aggregateId }) => aggregateId));
      await publishClaims(batch);
    }
    expect(controls.sort()).toEqual([cancelled.runId, expired.runId].sort());
    await expect(transitionRun(cancelled.runId, 'running')).rejects.toSatisfy(
      hasPostgresCode('PTC02'),
    );
    await transitionRun(cancelled.runId, 'canceled');
    await transitionRun(expired.runId, 'failed');
  });
}
