import { expect, it } from 'vitest';
import { claimPreviewDelivery } from '../../../src/previews/attempts/claim.repository.js';
import { PREVIEW_STATUS } from '../../../src/previews/state.js';
import {
  acceptFixture,
  claimFixture,
  previewTerminalFacts,
  scopedQuery,
  workerPool,
  workspaceId,
} from '../worker.fixture.js';

export function registerBoundsClaimOwnershipByImmutable(): void {
  it('bounds claim ownership by the immutable execution deadline', async () => {
    const executionDeadlineAt = new Date(Date.now() + 2_000);
    const claimed = await claimFixture(
      await acceptFixture({
        executionDeadlineAt,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      'worker-preview-deadline-bounded',
      3_600,
    );
    expect(claimed.lease.executionDeadlineAt.getTime()).toBe(
      executionDeadlineAt.getTime(),
    );
    const state = await scopedQuery<{ lease_expires_at: Date }>(
      `select lease_expires_at from app.preview_attempts
       where workspace_id=$1 and id=$2`,
      [workspaceId, claimed.fixture.previewAttemptId],
    );
    expect(state.rows[0]?.lease_expires_at.getTime()).toBeLessThanOrEqual(
      executionDeadlineAt.getTime(),
    );
  });

  it('terminalizes a queued preview before a post-deadline claim reaches a provider', async () => {
    const executionDeadlineAt = new Date(Date.now() + 1_500);
    const fixture = await acceptFixture({
      executionDeadlineAt,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect
      .poll(
        async () => {
          const clock = await scopedQuery<{ reached: boolean }>(
            `select clock_timestamp() >= $1::timestamptz reached`,
            [executionDeadlineAt],
          );
          return clock.rows[0]?.reached ?? false;
        },
        { timeout: 3_000, interval: 20 },
      )
      .toBe(true);

    await expect(
      claimPreviewDelivery(workerPool, {
        delivery: fixture.delivery,
        leaseDurationSeconds: 30,
        previewAttemptId: fixture.previewAttemptId,
        previewRunId: fixture.previewRunId,
        workerId: 'worker-preview-after-deadline',
        workspaceId,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });

    const state = await scopedQuery<{
      attempt_fence_token: string;
      attempt_status: string;
      completed_receipts: number;
      reconciliation_deliveries: number;
      run_status: string;
    }>(
      `select attempt.status attempt_status,run.status run_status,
              attempt.fence_token::text attempt_fence_token,
              (select count(*)::int from app.inbox_receipts
                where workspace_id=$1 and message_id=$4
                  and completed_at is not null) completed_receipts,
              (select count(*)::int from app.outbox_events
                where workspace_id=$1 and aggregate_id=$2
                  and job_name='reconcile-preview-attempt')
                reconciliation_deliveries
         from app.preview_runs run
         join app.preview_attempts attempt
           on attempt.workspace_id=run.workspace_id
          and attempt.preview_run_id=run.id
        where run.workspace_id=$1 and run.id=$2 and attempt.id=$3`,
      [
        workspaceId,
        fixture.previewRunId,
        fixture.previewAttemptId,
        fixture.delivery.outboxEventId,
      ],
    );
    expect(state.rows).toEqual([
      {
        attempt_fence_token: '1',
        attempt_status: PREVIEW_STATUS.timedOut,
        completed_receipts: 1,
        reconciliation_deliveries: 0,
        run_status: PREVIEW_STATUS.timedOut,
      },
    ]);
    const facts = await previewTerminalFacts(fixture.previewRunId);
    expect(facts.audit).toHaveLength(1);
    expect(facts.audit[0]?.metadata).toMatchObject({
      previewAttemptId: fixture.previewAttemptId,
      status: PREVIEW_STATUS.timedOut,
    });
    expect(facts.usage).toHaveLength(1);
    expect(facts.usage[0]).toMatchObject({
      idempotency_key: `preview-terminal:${fixture.previewRunId}`,
      metadata: { status: PREVIEW_STATUS.timedOut },
      quantity: '1',
    });
  });
}
