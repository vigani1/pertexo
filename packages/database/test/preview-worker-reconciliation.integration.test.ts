import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  claimPreviewDelivery,
  completePreviewAttempt,
  heartbeatPreviewLease,
  markPreviewDispatched,
  PREVIEW_STATUS,
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
  reconcileExpiredPreviewAttempt,
  reconcilePreviewDelivery,
} from '../src/preview-execution.js';
import {
  acceptFixture,
  claimFixture,
  expireLease,
  previewTerminalFacts,
  reconciliationFixture,
  scopedQuery,
  workerPool,
  workspaceId,
} from './support/preview-worker-fixture.js';

describe('preview worker lease reconciliation', () => {
  it('reconciles expired attempts by dispatch evidence and side-effect class', async () => {
    const beforeDispatch = await claimFixture(
      await acceptFixture(),
      'worker-preview-g',
      5,
    );
    await expireLease(beforeDispatch.fixture.previewAttemptId);
    await expect(
      reconcileExpiredPreviewAttempt(workerPool, {
        previewAttemptId: beforeDispatch.fixture.previewAttemptId,
        previewRunId: beforeDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'reconciliation_reclaim_required' });
    const reclaimedBeforeDispatch = await claimFixture(
      beforeDispatch.fixture,
      'worker-preview-g2',
    );
    expect(reclaimedBeforeDispatch.lease.attemptFenceToken).toBe(
      beforeDispatch.lease.attemptFenceToken + 1,
    );

    const afterDispatch = await claimFixture(
      await acceptFixture(),
      'worker-preview-h',
      5,
    );
    await markPreviewDispatched(workerPool, {
      lease: afterDispatch.lease,
      workerId: afterDispatch.workerId,
    });
    await expireLease(afterDispatch.fixture.previewAttemptId);
    await expect(
      reconcileExpiredPreviewAttempt(workerPool, {
        previewAttemptId: afterDispatch.fixture.previewAttemptId,
        previewRunId: afterDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toEqual({ status: PREVIEW_STATUS.outcomeUnknown });

    const safeAfterDispatch = await claimFixture(
      await acceptFixture({
        mayCauseExternalSideEffect: false,
        sideEffectClass: 'safe',
      }),
      'worker-preview-safe',
      5,
    );
    await markPreviewDispatched(workerPool, {
      lease: safeAfterDispatch.lease,
      workerId: safeAfterDispatch.workerId,
    });
    await expireLease(safeAfterDispatch.fixture.previewAttemptId);
    await expect(
      reconcileExpiredPreviewAttempt(workerPool, {
        previewAttemptId: safeAfterDispatch.fixture.previewAttemptId,
        previewRunId: safeAfterDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'reconciliation_reclaim_required' });
    const reclaimedSafe = await claimFixture(
      safeAfterDispatch.fixture,
      'worker-preview-safe2',
    );
    expect(reclaimedSafe.lease.attemptFenceToken).toBe(
      safeAfterDispatch.lease.attemptFenceToken + 1,
    );

    const idempotentAfterDispatch = await claimFixture(
      await acceptFixture({
        providerIdempotencyKey: `preview-key-${randomUUID()}`,
        sideEffectClass: 'idempotent_with_key',
      }),
      'worker-preview-keyed',
      5,
    );
    const providerDispatchBinding = 'email:v1:sha256:' + 'e'.repeat(64);
    expect(
      idempotentAfterDispatch.lease.providerDispatchUnresolved,
    ).toBeUndefined();
    await markPreviewDispatched(workerPool, {
      lease: idempotentAfterDispatch.lease,
      providerDispatchBinding,
      workerId: idempotentAfterDispatch.workerId,
    });
    await expireLease(idempotentAfterDispatch.fixture.previewAttemptId);
    await expect(
      reconcileExpiredPreviewAttempt(workerPool, {
        previewAttemptId: idempotentAfterDispatch.fixture.previewAttemptId,
        previewRunId: idempotentAfterDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'reconciliation_reclaim_required' });
    const reclaimedIdempotent = await claimFixture(
      idempotentAfterDispatch.fixture,
      'worker-preview-keyed2',
    );
    expect(reclaimedIdempotent.lease.providerIdempotencyKey).toBe(
      idempotentAfterDispatch.lease.providerIdempotencyKey,
    );
    expect(reclaimedIdempotent.lease.providerDispatchBinding).toBe(
      providerDispatchBinding,
    );
    expect(reclaimedIdempotent.lease.providerDispatchUnresolved).toBe(true);

    const runs = await scopedQuery<{
      id: string;
      status: string;
      safe_error_code: string | null;
      output_ref: unknown;
    }>(
      `select id,status,safe_error_code,output_ref from app.preview_runs
       where workspace_id=$1 and id=any($2::uuid[]) order by id`,
      [workspaceId, [afterDispatch.fixture.previewRunId]],
    );
    const statusById = new Map(runs.rows.map((row) => [row.id, row.status]));
    expect(statusById.get(afterDispatch.fixture.previewRunId)).toBe(
      PREVIEW_STATUS.outcomeUnknown,
    );
    for (const row of runs.rows) expect(row.output_ref).toBeNull();

    // A live lease blocks reconciliation, and once terminal it is idempotent.
    const live = await claimFixture(await acceptFixture(), 'worker-preview-i');
    await expect(
      reconcileExpiredPreviewAttempt(workerPool, {
        previewAttemptId: live.fixture.previewAttemptId,
        previewRunId: live.fixture.previewRunId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(PreviewAttemptStateError);
    await expireLease(live.fixture.previewAttemptId);
    await expect(
      reconcileExpiredPreviewAttempt(workerPool, {
        previewAttemptId: afterDispatch.fixture.previewAttemptId,
        previewRunId: afterDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toEqual({ status: PREVIEW_STATUS.outcomeUnknown });
  });

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
          output: { schemaVersion: 1, kind: 'inline', value: 'stale' },
          status: PREVIEW_STATUS.succeeded,
        },
        workerId: claimed.workerId,
      }),
    ).rejects.toMatchObject({ code: 'completion_lost' });

    const replacementClaim = await claimPreviewDelivery(workerPool, {
      delivery: {
        outboxEventId: redelivered.executionOutboxEventId,
        payloadChecksum: replacementRow.payload_checksum,
      },
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
    }
  });

  it('records unsafe post-dispatch ambiguity from the durable wake-up', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'worker-preview-reconcile-unsafe',
      5,
    );
    const reconciliation = await reconciliationFixture(claimed);
    await markPreviewDispatched(workerPool, {
      lease: claimed.lease,
      workerId: claimed.workerId,
    });
    await expireLease(claimed.fixture.previewAttemptId);

    await expect(
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: reconciliation.attemptFenceToken,
        delivery: reconciliation.delivery,
        previewAttemptId: claimed.fixture.previewAttemptId,
        previewRunId: claimed.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toMatchObject({
      kind: 'completed',
      status: PREVIEW_STATUS.outcomeUnknown,
    });
    const state = await scopedQuery<{
      fence_token: string;
      reconciliation_ref: Record<string, unknown>;
      status: string;
    }>(
      `select status,fence_token,reconciliation_ref
       from app.preview_attempts where workspace_id=$1 and id=$2`,
      [workspaceId, claimed.fixture.previewAttemptId],
    );
    expect(state.rows[0]).toMatchObject({
      status: PREVIEW_STATUS.outcomeUnknown,
      reconciliation_ref: {
        reason: 'lease_expired_after_unsafe_dispatch',
      },
    });
    expect(Number(state.rows[0]?.fence_token)).toBe(
      claimed.lease.attemptFenceToken + 1,
    );
    const facts = await previewTerminalFacts(claimed.fixture.previewRunId);
    expect(facts.audit).toHaveLength(1);
    expect(facts.usage).toHaveLength(1);
    expect(facts.audit[0]?.metadata).toMatchObject({
      status: PREVIEW_STATUS.outcomeUnknown,
    });
    expect(facts.usage[0]?.metadata).toMatchObject({
      status: PREVIEW_STATUS.outcomeUnknown,
    });
  });

  it('times out expired undispatched work instead of redelivering past its deadline', async () => {
    const claimed = await claimFixture(
      await acceptFixture({
        expiresAt: new Date(Date.now() + 250),
        mayCauseExternalSideEffect: false,
        sideEffectClass: 'safe',
      }),
      'worker-preview-reconcile-deadline',
      5,
    );
    const reconciliation = await reconciliationFixture(claimed);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expireLease(claimed.fixture.previewAttemptId);

    await expect(
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: reconciliation.attemptFenceToken,
        delivery: reconciliation.delivery,
        previewAttemptId: claimed.fixture.previewAttemptId,
        previewRunId: claimed.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toMatchObject({
      kind: 'completed',
      status: PREVIEW_STATUS.timedOut,
    });
    const replacement = await scopedQuery<{ count: string }>(
      `select count(*)::text as count from app.outbox_events
       where workspace_id=$1 and aggregate_id=$2
         and job_name='execute-preview-attempt' and id<>$3`,
      [
        workspaceId,
        claimed.fixture.previewRunId,
        claimed.fixture.outboxEventId,
      ],
    );
    expect(replacement.rows[0]).toEqual({ count: '0' });
  });

  it('checksum-binds reconciliation deliveries and audits forged reuse', async () => {
    const claimed = await claimFixture(
      await acceptFixture({
        mayCauseExternalSideEffect: false,
        sideEffectClass: 'safe',
      }),
      'worker-preview-reconcile-security',
      5,
    );
    const reconciliation = await reconciliationFixture(claimed);
    await expect(
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: reconciliation.attemptFenceToken,
        delivery: {
          ...reconciliation.delivery,
          payloadChecksum: '0'.repeat(64),
        },
        previewAttemptId: claimed.fixture.previewAttemptId,
        previewRunId: claimed.fixture.previewRunId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(PreviewDeliveryMismatchError);
    const facts = await scopedQuery<{ count: string }>(
      `select count(*)::text as count
       from app.transport_security_audit_facts
       where workspace_id=$1 and message_id=$2
         and consumer_name='preview-attempt-reconciler'`,
      [workspaceId, reconciliation.outboxEventId],
    );
    expect(facts.rows[0]).toEqual({ count: '1' });
  });

  it('hides cross-workspace claims under forced RLS', async () => {
    const fixture = await acceptFixture();
    await expect(
      claimPreviewDelivery(workerPool, {
        delivery: fixture.delivery,
        leaseDurationSeconds: 30,
        previewAttemptId: fixture.previewAttemptId,
        previewRunId: fixture.previewRunId,
        workerId: 'worker-preview-j',
        workspaceId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(PreviewAttemptStateError);
  });
});
