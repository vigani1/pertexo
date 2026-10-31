import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { acceptWorkflowRun } from '../../../../src/runs/commands/acceptance.repository.js';
import { WorkspaceRunQuotaExceededError } from '../../../../src/runs/commands/acceptance/errors.js';
import {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from '../../../../src/outbox/events.repository.js';
import {
  acceptanceInput,
  apiDatabase,
  dispatcherDatabase,
  expectAcceptanceRecordCounts,
  hasPostgresCode,
  migrationUrl,
  workerDatabase,
  workspaceA,
  workspaceB,
} from '../fixtures.js';

export function registerAtomicallyAdmitsExactlyOneHundred(): void {
  it('atomically admits exactly one hundred of one hundred and one concurrent queued runs', async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 101 }, (_, index) =>
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, {
            ...acceptanceInput(
              createHash('sha256')
                .update(`request-${String(index)}`)
                .digest('hex'),
            ),
            keyHash: createHash('sha256')
              .update(`key-${String(index)}`)
              .digest('hex'),
            scope: `quota:${String(index)}`,
          }),
        ),
      ),
    );
    expect(
      outcomes.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(100);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(WorkspaceRunQuotaExceededError);
    await expectAcceptanceRecordCounts(100);

    const admitted = outcomes.find(
      (
        outcome,
      ): outcome is PromiseFulfilledResult<
        Awaited<ReturnType<typeof acceptWorkflowRun>>
      > => outcome.status === 'fulfilled',
    );
    if (admitted === undefined) throw new Error('Expected an admitted run');
    await workerDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
        update app.workflow_runs set status='running'
         where workspace_id=${workspaceA} and id=${admitted.value.runId}
      `),
    );
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, {
        ...acceptanceInput(
          createHash('sha256').update('replacement-request').digest('hex'),
        ),
        keyHash: createHash('sha256').update('replacement-key').digest('hex'),
        scope: 'quota:replacement',
      }),
    );
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
          update app.workflow_runs set status='queued'
           where workspace_id=${workspaceA} and id=${admitted.value.runId}
        `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('PTA02'));
  });

  it('reserves active capacity before coordinator outbox work reaches BullMQ', async () => {
    const accepted = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, {
            ...acceptanceInput(
              createHash('sha256')
                .update(`dispatch-request-${String(index)}`)
                .digest('hex'),
            ),
            keyHash: createHash('sha256')
              .update(`dispatch-key-${String(index)}`)
              .digest('hex'),
            scope: `dispatch:${String(index)}`,
          }),
        ),
      ),
    );
    const claim = () =>
      dispatcherDatabase.claimBatch({
        enabledJobNames: ['advance-workflow-run'],
        leaseDurationMillis: 30_000,
        leaseOwner: 'active-admission-test',
        leaseToken: randomUUID(),
        limit: 1,
      });
    const admittedEventIds: string[] = [];
    const admittedRunIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const batch = await claim();
      const event = batch.events[0];
      if (event === undefined)
        throw new Error(`Expected admitted outbox work ${String(index + 1)}`);
      admittedEventIds.push(event.id);
      admittedRunIds.push(event.aggregateId);
      await expect(
        dispatcherDatabase.markPublished(event.id, event.leaseToken),
      ).resolves.toBe(true);
    }
    await expect(claim()).resolves.toMatchObject({ events: [] });

    const otherEventId = randomUUID();
    const otherPayload = {
      workspaceId: workspaceB,
      outboxEventId: otherEventId,
    } as const;
    await apiDatabase.withWorkspace(workspaceB, (transaction) =>
      insertOutboxEvent(transaction, {
        id: otherEventId,
        jobName: 'phase0-duplicate-proof',
        aggregateType: 'fairness-probe',
        aggregateId: randomUUID(),
        payload: otherPayload,
        payloadChecksum: canonicalOutboxPayloadChecksum(otherPayload),
        availableAt: new Date(0),
      }),
    );
    const cursorOwner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await cursorOwner.query('begin');
      await cursorOwner.query('set local role pertexo_owner');
      await cursorOwner.query(
        `update app.outbox_fair_dispatch_cursor set last_workspace_id=$1`,
        [workspaceB],
      );
      await cursorOwner.query('commit');
    } finally {
      await cursorOwner.query('rollback').catch(() => undefined);
      await cursorOwner.end();
    }
    const mixedClaim = () =>
      dispatcherDatabase.claimBatch({
        enabledJobNames: ['advance-workflow-run', 'phase0-duplicate-proof'],
        leaseDurationMillis: 30_000,
        leaseOwner: 'saturated-window-test',
        leaseToken: randomUUID(),
        limit: 1,
      });
    await expect(mixedClaim()).resolves.toMatchObject({ events: [] });
    const afterSaturatedWindow = await mixedClaim();
    expect(afterSaturatedWindow.events[0]?.id).toBe(otherEventId);
    const otherEvent = afterSaturatedWindow.events[0];
    if (otherEvent === undefined)
      throw new Error('Expected fair probe delivery');
    await dispatcherDatabase.markPublished(
      otherEvent.id,
      otherEvent.leaseToken,
    );

    const firstEventId = admittedEventIds[0];
    if (firstEventId === undefined)
      throw new Error('Expected admitted outbox identity');
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `update app.workflow_run_active_admissions
            set recover_after='-infinity'::timestamptz
          where outbox_event_id=$1`,
        [firstEventId],
      );
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
    const recovered = await claim();
    expect(recovered.events[0]?.id).not.toBe(firstEventId);
    expect(recovered.events[0]?.aggregateId).toBe(admittedRunIds[0]);
    expect(recovered.events[0]?.payloadChecksum).toBe(
      canonicalOutboxPayloadChecksum(recovered.events[0]?.payload),
    );
    const recoveredEvent = recovered.events[0];
    if (recoveredEvent === undefined)
      throw new Error('Expected recovered coordinator delivery');
    await expect(
      dispatcherDatabase.markPublished(
        recoveredEvent.id,
        recoveredEvent.leaseToken,
      ),
    ).resolves.toBe(true);

    const firstRunId = admittedRunIds[0];
    if (firstRunId === undefined)
      throw new Error('Expected admitted run identity');
    await workerDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
        update app.workflow_runs set status='running'
         where workspace_id=${workspaceA} and id=${firstRunId}
      `),
    );
    await workerDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
        update app.workflow_runs set status='succeeded'
         where workspace_id=${workspaceA} and id=${firstRunId}
      `),
    );
    const released = await claim();
    expect(released.events).toHaveLength(1);
    expect(
      accepted.some(({ runId }) => runId === released.events[0]?.aggregateId),
    ).toBe(true);
  });
}
