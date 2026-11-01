import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  hasPostgresCode,
  workspaceA,
  workspaceB,
} from '../../../runs/acceptance/fixtures.js';
import {
  acceptRun,
  claimRuns,
  publishClaims,
  setLimit,
  withOwner,
  withDispatcher,
} from '../concurrency-admission.fixtures.js';
import {
  reservations,
  withWorker,
  pendingDelivery,
  rebind,
} from './fixture.js';

export function registerRestrictsReservationRebindAppRole(): void {
  it('restricts reservation rebind to the app role and installed workspace context', async () => {
    const run = await acceptRun();
    const next = await pendingDelivery(run.runId);
    const ids = [workspaceA, run.runId, run.outboxEventId, next] as const;
    await expect(
      withDispatcher((client) =>
        client.query(
          'select app.rebind_workflow_run_active_admission($1,$2,$3,$4)',
          [...ids],
        ),
      ),
    ).rejects.toSatisfy(hasPostgresCode('42501'));
    await expect(
      withWorker((client) =>
        client.query(
          'select app.rebind_workflow_run_active_admission($1,$2,$3,$4)',
          [workspaceB, run.runId, run.outboxEventId, next],
        ),
      ),
    ).rejects.toSatisfy(hasPostgresCode('42501'));
  });

  it('rejects foreign run, old/new outbox, and forged payload bindings without mutation', async () => {
    await setLimit(2);
    const first = await acceptRun();
    const other = await acceptRun();
    const grant = await claimRuns();
    await publishClaims(grant);
    const next = await pendingDelivery(first.runId);
    const otherNext = await pendingDelivery(other.runId);
    const forged = await pendingDelivery(first.runId, other.runId);
    const before = await reservations();
    for (const [run, old, target] of [
      [randomUUID(), first.outboxEventId, next],
      [first.runId, other.outboxEventId, next],
      [first.runId, first.outboxEventId, otherNext],
      [first.runId, first.outboxEventId, forged],
      [first.runId, first.outboxEventId, first.outboxEventId],
    ] as const) {
      expect(await rebind(run, old, target)).toBe(false);
      expect(await reservations()).toEqual(before);
    }
  });

  it('does not steal a reservation whose transport identity was rebound by real recovery', async () => {
    await setLimit(1);
    const run = await acceptRun();
    const initial = await claimRuns();
    await publishClaims(initial);
    await withOwner((client) =>
      client.query(
        "update app.workflow_run_active_admissions set recover_after=clock_timestamp()-interval '1 second' where workflow_run_id=$1",
        [run.runId],
      ),
    );
    const recovered = await claimRuns();
    const recoveredEvent = recovered.events[0];
    if (recoveredEvent === undefined)
      throw new Error('Missing recovered reservation transport');
    expect(recoveredEvent.id).not.toBe(run.outboxEventId);
    const before = await reservations();
    const attempted = await pendingDelivery(run.runId);
    expect(await rebind(run.runId, run.outboxEventId, attempted)).toBe(false);
    expect(await reservations()).toEqual(before);
    expect(before[0]?.outbox_event_id).toBe(recoveredEvent.id);
    expect(before[0]?.recovery_count).toBe(1);
  });
}
