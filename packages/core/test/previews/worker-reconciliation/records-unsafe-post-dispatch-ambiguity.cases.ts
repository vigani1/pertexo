import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { claimPreviewDelivery } from '../../../src/previews/attempts/claim.js';
import { markPreviewDispatched } from '../../../src/previews/attempts/mark-dispatched.js';
import { PREVIEW_STATUS } from '../../../src/previews/state.js';
import {
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
} from '../../../src/previews/errors.js';
import { reconcilePreviewDelivery } from '../../../src/previews/reconciliation/reconcile.js';
import {
  acceptFixture,
  claimFixture,
  expireLease,
  previewTerminalFacts,
  reconciliationFixture,
  scopedQuery,
  workerPool,
  workspaceId,
} from '../worker.fixture.js';
import { waitForDatabaseTime } from './fixture.js';

export function registerRecordsUnsafePostDispatchAmbiguity(): void {
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
    const executionDeadlineAt = new Date(Date.now() + 1_500);
    const claimed = await claimFixture(
      await acceptFixture({
        executionDeadlineAt,
        expiresAt: new Date(Date.now() + 60_000),
        mayCauseExternalSideEffect: false,
        sideEffectClass: 'safe',
      }),
      'worker-preview-reconcile-deadline',
      5,
    );
    const reconciliation = await reconciliationFixture(claimed);
    await waitForDatabaseTime(executionDeadlineAt);

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
}
