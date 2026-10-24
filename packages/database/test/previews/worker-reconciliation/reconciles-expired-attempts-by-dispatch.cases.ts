import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { markPreviewDispatched } from '../../../src/previews/attempts/dispatch.repository.js';
import { PREVIEW_STATUS } from '../../../src/previews/state.js';
import { reconcilePreviewDelivery } from '../../../src/previews/reconciliation/deliveries.repository.js';
import {
  acceptFixture,
  claimFixture,
  expireLease,
  reconciliationFixture,
  scopedQuery,
  workerPool,
  workspaceId,
} from '../worker.fixture.js';

export function registerReconcilesExpiredAttemptsByDispatch(): void {
  it('reconciles expired attempts by dispatch evidence and side-effect class', async () => {
    const beforeDispatch = await claimFixture(
      await acceptFixture(),
      'worker-preview-g',
      5,
    );
    const beforeDispatchDelivery = await reconciliationFixture(beforeDispatch);
    await expireLease(beforeDispatch.fixture.previewAttemptId);
    await expect(
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: beforeDispatchDelivery.attemptFenceToken,
        delivery: beforeDispatchDelivery.delivery,
        previewAttemptId: beforeDispatch.fixture.previewAttemptId,
        previewRunId: beforeDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toMatchObject({ kind: 'redelivered' });
    const reclaimedBeforeDispatch = await claimFixture(
      beforeDispatch.fixture,
      'worker-preview-g2',
    );
    expect(reclaimedBeforeDispatch.lease.attemptFenceToken).toBe(
      beforeDispatch.lease.attemptFenceToken + 2,
    );

    const afterDispatch = await claimFixture(
      await acceptFixture(),
      'worker-preview-h',
      5,
    );
    const afterDispatchDelivery = await reconciliationFixture(afterDispatch);
    await markPreviewDispatched(workerPool, {
      lease: afterDispatch.lease,
      workerId: afterDispatch.workerId,
    });
    await expireLease(afterDispatch.fixture.previewAttemptId);
    await expect(
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: afterDispatchDelivery.attemptFenceToken,
        delivery: afterDispatchDelivery.delivery,
        previewAttemptId: afterDispatch.fixture.previewAttemptId,
        previewRunId: afterDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toMatchObject({
      kind: 'completed',
      status: PREVIEW_STATUS.outcomeUnknown,
    });

    const safeAfterDispatch = await claimFixture(
      await acceptFixture({
        mayCauseExternalSideEffect: false,
        sideEffectClass: 'safe',
      }),
      'worker-preview-safe',
      5,
    );
    const safeDelivery = await reconciliationFixture(safeAfterDispatch);
    await markPreviewDispatched(workerPool, {
      lease: safeAfterDispatch.lease,
      workerId: safeAfterDispatch.workerId,
    });
    await expireLease(safeAfterDispatch.fixture.previewAttemptId);
    await expect(
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: safeDelivery.attemptFenceToken,
        delivery: safeDelivery.delivery,
        previewAttemptId: safeAfterDispatch.fixture.previewAttemptId,
        previewRunId: safeAfterDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toMatchObject({ kind: 'redelivered' });
    const reclaimedSafe = await claimFixture(
      safeAfterDispatch.fixture,
      'worker-preview-safe2',
    );
    expect(reclaimedSafe.lease.attemptFenceToken).toBe(
      safeAfterDispatch.lease.attemptFenceToken + 2,
    );

    const idempotentAfterDispatch = await claimFixture(
      await acceptFixture({
        providerIdempotencyKey: `preview-key-${randomUUID()}`,
        sideEffectClass: 'idempotent_with_key',
      }),
      'worker-preview-keyed',
      5,
    );
    const keyedDelivery = await reconciliationFixture(idempotentAfterDispatch);
    const providerDispatchBinding = 'email:sha256:' + 'e'.repeat(64);
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
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: keyedDelivery.attemptFenceToken,
        delivery: keyedDelivery.delivery,
        previewAttemptId: idempotentAfterDispatch.fixture.previewAttemptId,
        previewRunId: idempotentAfterDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toMatchObject({ kind: 'redelivered' });
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
    const liveDelivery = await reconciliationFixture(live);
    await expect(
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: liveDelivery.attemptFenceToken,
        delivery: liveDelivery.delivery,
        previewAttemptId: live.fixture.previewAttemptId,
        previewRunId: live.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toMatchObject({ kind: 'rescheduled' });
    await expireLease(live.fixture.previewAttemptId);
    await expect(
      reconcilePreviewDelivery(workerPool, {
        attemptFenceToken: afterDispatchDelivery.attemptFenceToken,
        delivery: afterDispatchDelivery.delivery,
        previewAttemptId: afterDispatch.fixture.previewAttemptId,
        previewRunId: afterDispatch.fixture.previewRunId,
        workspaceId,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
  });
}
