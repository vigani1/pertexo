import { expect, it, vi } from 'vitest';
import { claimPreviewDelivery } from '../../../src/previews/attempts/claim.js';
import { completePreviewAttempt } from '../../../src/previews/attempts/complete.js';
import { heartbeatPreviewLease } from '../../../src/previews/attempts/heartbeat.js';
import { markPreviewDispatched } from '../../../src/previews/attempts/mark-dispatched.js';
import { PREVIEW_STATUS } from '../../../src/previews/state.js';
import { reconcilePreviewDelivery } from '../../../src/previews/reconciliation/reconcile.js';
import {
  acceptFixture,
  claimFixture,
  expireLease,
  reconciliationFixture,
  scopedQuery,
  workerPool,
  workspaceId,
} from '../worker.fixture.js';

export function registerDurablySchedulesReschedulesDeduplicatesLease(): void {
  it('durably schedules, reschedules, and deduplicates lease reconciliation', async () => {
    const claimed = await claimFixture(
      await acceptFixture({
        mayCauseExternalSideEffect: false,
        sideEffectClass: 'safe',
      }),
      'worker-preview-reconcile-live',
      5,
    );
    const initial = await reconciliationFixture(claimed);
    expect(initial.availableAt.getTime()).toBeGreaterThan(Date.now());

    const heartbeat = await heartbeatPreviewLease(workerPool, {
      lease: claimed.lease,
      leaseDurationSeconds: 30,
      workerId: claimed.workerId,
    });
    const rescheduled = await reconcilePreviewDelivery(workerPool, {
      attemptFenceToken: initial.attemptFenceToken,
      delivery: initial.delivery,
      previewAttemptId: claimed.fixture.previewAttemptId,
      previewRunId: claimed.fixture.previewRunId,
      workspaceId,
    });
    expect(rescheduled).toMatchObject({ kind: 'rescheduled' });
    const successorId =
      rescheduled.kind === 'rescheduled'
        ? rescheduled.reconciliationOutboxEventId
        : undefined;
    expect(successorId).toBeDefined();
    const successor = await scopedQuery<{
      available_at: Date;
      job_name: string;
    }>(
      `select available_at,job_name from app.outbox_events
       where workspace_id=$1 and id=$2`,
      [workspaceId, successorId],
    );
    expect(successor.rows[0]).toMatchObject({
      job_name: 'reconcile-preview-attempt',
    });
    expect(successor.rows[0]?.available_at.getTime()).toBe(
      heartbeat.attemptLeaseExpiresAt.getTime(),
    );

    await expect(
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: initial.attemptFenceToken,
        delivery: initial.delivery,
        previewAttemptId: claimed.fixture.previewAttemptId,
        previewRunId: claimed.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
    const successorCount = await scopedQuery<{ count: string }>(
      `select count(*)::text as count from app.outbox_events
       where workspace_id=$1 and id=$2`,
      [workspaceId, successorId],
    );
    expect(successorCount.rows[0]).toEqual({ count: '1' });
  });

  it('fences and redelivers expired reclaimable work through a new outbox event', async () => {
    const claimed = await claimFixture(
      await acceptFixture({
        mayCauseExternalSideEffect: false,
        sideEffectClass: 'safe',
      }),
      'worker-preview-reconcile-safe',
      5,
    );
    const reconciliation = await reconciliationFixture(claimed);
    await markPreviewDispatched(workerPool, {
      lease: claimed.lease,
      workerId: claimed.workerId,
    });
    await expireLease(claimed.fixture.previewAttemptId);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
    const redelivered = await reconcilePreviewDelivery(workerPool, {
      attemptFenceToken: reconciliation.attemptFenceToken,
      delivery: reconciliation.delivery,
      previewAttemptId: claimed.fixture.previewAttemptId,
      previewRunId: claimed.fixture.previewRunId,
      workspaceId,
    }).finally(() => vi.useRealTimers());
    expect(redelivered).toMatchObject({ kind: 'redelivered' });
    if (redelivered.kind !== 'redelivered')
      throw new Error('expected execution redelivery');
    const replacement = await scopedQuery<{
      available_at: Date;
      database_now: Date;
      payload: Record<string, unknown>;
      payload_checksum: string;
    }>(
      `select payload,payload_checksum,available_at,
              clock_timestamp() as database_now
       from app.outbox_events
       where workspace_id=$1 and id=$2 and job_name='execute-preview-attempt'`,
      [workspaceId, redelivered.executionOutboxEventId],
    );
    const replacementRow = replacement.rows[0];
    if (replacementRow === undefined)
      throw new Error('replacement execution outbox missing');
    expect(
      Math.abs(
        replacementRow.available_at.getTime() -
          replacementRow.database_now.getTime(),
      ),
    ).toBeLessThan(5_000);
    await expect(
      completePreviewAttempt(workerPool, {
        delivery: claimed.fixture.delivery,
        lease: claimed.lease,
        outcome: {
          output: { kind: 'inline', value: 'stale' },
          status: PREVIEW_STATUS.succeeded,
        },
        workerId: claimed.workerId,
      }),
    ).rejects.toMatchObject({ code: 'completion_lost' });

    const replacementDelivery = {
      outboxEventId: redelivered.executionOutboxEventId,
      payloadChecksum: replacementRow.payload_checksum,
    };
    const replacementClaim = await claimPreviewDelivery(workerPool, {
      delivery: replacementDelivery,
      leaseDurationSeconds: 30,
      previewAttemptId: claimed.fixture.previewAttemptId,
      previewRunId: claimed.fixture.previewRunId,
      workerId: 'worker-preview-reconcile-safe-2',
      workspaceId,
    });
    expect(replacementClaim.kind).toBe('claimed');
    if (replacementClaim.kind === 'claimed') {
      expect(replacementClaim.lease.attemptFenceToken).toBe(
        claimed.lease.attemptFenceToken + 2,
      );
      const replacementOutput = {
        kind: 'inline',
        value: 'replacement-confirmed',
      } as const;
      await expect(
        completePreviewAttempt(workerPool, {
          delivery: replacementDelivery,
          lease: replacementClaim.lease,
          outcome: {
            output: replacementOutput,
            status: PREVIEW_STATUS.succeeded,
          },
          workerId: 'worker-preview-reconcile-safe-2',
        }),
      ).resolves.toEqual({ kind: 'committed' });
      await expect(
        completePreviewAttempt(workerPool, {
          delivery: replacementDelivery,
          lease: replacementClaim.lease,
          outcome: {
            output: replacementOutput,
            status: PREVIEW_STATUS.succeeded,
          },
          workerId: 'worker-preview-reconcile-safe-2',
        }),
      ).resolves.toEqual({ kind: 'duplicate' });
      await expect(
        completePreviewAttempt(workerPool, {
          delivery: claimed.fixture.delivery,
          lease: claimed.lease,
          outcome: {
            output: replacementOutput,
            status: PREVIEW_STATUS.succeeded,
          },
          workerId: claimed.workerId,
        }),
      ).rejects.toMatchObject({ code: 'completion_lost' });
    }
  });
}
