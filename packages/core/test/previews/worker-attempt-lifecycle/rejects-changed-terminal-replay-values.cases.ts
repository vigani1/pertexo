import { v7 as uuidv7 } from 'uuid';
import { expect, it } from 'vitest';
import { claimPreviewDelivery } from '../../../src/previews/attempts/claim.js';
import { completePreviewAttempt } from '../../../src/previews/attempts/complete.js';
import { PREVIEW_STATUS } from '../../../src/previews/state.js';
import { PreviewDeliveryMismatchError } from '../../../src/previews/errors.js';
import type { PreviewDelivery } from '../../../src/previews/contract.js';
import {
  acceptFixture,
  claimFixture,
  expectPgCode,
  previewTerminalFacts,
  scopedQuery,
  workerPool,
  workspaceId,
} from '../worker.fixture.js';
import { withTenantScopedClient } from '@pertexo/database/primitives';

export function registerRejectsChangedTerminalReplayValues(): void {
  it('rejects changed terminal replay values and identities without new facts', async () => {
    const success = await claimFixture(
      await acceptFixture(),
      'worker-preview-exact-success',
    );
    const originalOutput = {
      kind: 'inline',
      value: { quoted: 'a "quote" and a \\ slash' },
    } as const;
    await completePreviewAttempt(workerPool, {
      delivery: success.fixture.delivery,
      lease: success.lease,
      outcome: { output: originalOutput, status: PREVIEW_STATUS.succeeded },
      workerId: success.workerId,
    });
    await expect(
      completePreviewAttempt(workerPool, {
        delivery: success.fixture.delivery,
        lease: success.lease,
        outcome: { output: originalOutput, status: PREVIEW_STATUS.succeeded },
        workerId: success.workerId,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
    await expect(
      completePreviewAttempt(workerPool, {
        delivery: success.fixture.delivery,
        lease: success.lease,
        outcome: {
          output: {
            kind: 'inline',
            value: { quoted: 'changed' },
          },
          status: PREVIEW_STATUS.succeeded,
        },
        workerId: success.workerId,
      }),
    ).rejects.toMatchObject({ code: 'completion_lost' });

    const failure = await claimFixture(
      await acceptFixture(),
      'worker-preview-exact-failure',
    );
    await completePreviewAttempt(workerPool, {
      delivery: failure.fixture.delivery,
      lease: failure.lease,
      outcome: {
        safeErrorCode: 'preview.provider_rejected',
        status: PREVIEW_STATUS.failed,
      },
      workerId: failure.workerId,
    });
    await expect(
      completePreviewAttempt(workerPool, {
        delivery: failure.fixture.delivery,
        lease: failure.lease,
        outcome: {
          safeErrorCode: 'preview.changed_error',
          status: PREVIEW_STATUS.failed,
        },
        workerId: failure.workerId,
      }),
    ).rejects.toMatchObject({ code: 'completion_lost' });
    await expect(
      completePreviewAttempt(workerPool, {
        delivery: success.fixture.delivery,
        lease: { ...success.lease, previewRunId: failure.fixture.previewRunId },
        outcome: { output: originalOutput, status: PREVIEW_STATUS.succeeded },
        workerId: success.workerId,
      }),
    ).rejects.toBeInstanceOf(PreviewDeliveryMismatchError);

    const successFacts = await previewTerminalFacts(
      success.fixture.previewRunId,
    );
    const failureFacts = await previewTerminalFacts(
      failure.fixture.previewRunId,
    );
    expect(successFacts.audit).toHaveLength(1);
    expect(successFacts.usage).toHaveLength(1);
    expect(failureFacts.audit).toHaveLength(1);
    expect(failureFacts.usage).toHaveLength(1);
    const mismatchFacts = await scopedQuery<{ count: string }>(
      `select count(*)::text count
       from app.transport_security_audit_facts
       where workspace_id=$1 and consumer_name='preview-attempt-worker'
         and message_id=$2`,
      [workspaceId, success.fixture.delivery.outboxEventId],
    );
    expect(mismatchFacts.rows).toEqual([{ count: '1' }]);
  });

  it('rolls the terminal transition back when its facts cannot commit', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'worker-preview-terminal-fact-atomicity',
    );
    await withTenantScopedClient(workerPool, { workspaceId }, (client) =>
      client.query(
        `insert into app.usage_events (
           id,workspace_id,category,quantity,resource_type,resource_id,
           idempotency_key,metadata
         ) values ($1,$2,'preview_execution',1,'preview-run',$3,$4,'{}')`,
        [
          uuidv7(),
          workspaceId,
          claimed.fixture.previewRunId,
          `preview-terminal:${claimed.fixture.previewRunId}`,
        ],
      ),
    );

    await expect(
      completePreviewAttempt(workerPool, {
        delivery: claimed.fixture.delivery,
        lease: claimed.lease,
        outcome: {
          safeErrorCode: 'preview.provider_rejected',
          status: PREVIEW_STATUS.failed,
        },
        workerId: claimed.workerId,
      }),
    ).rejects.toSatisfy(expectPgCode('23505'));

    const state = await scopedQuery<{ status: string }>(
      `select status from app.preview_runs
        where workspace_id=$1 and id=$2`,
      [workspaceId, claimed.fixture.previewRunId],
    );
    expect(state.rows).toEqual([{ status: PREVIEW_STATUS.running }]);
    const facts = await previewTerminalFacts(claimed.fixture.previewRunId);
    expect(facts.audit).toHaveLength(0);
    expect(facts.usage).toHaveLength(1);
  });

  it('rejects a forged checksum reuse of a valid outbox row with a security fact', async () => {
    const fixture = await acceptFixture();
    const forged: PreviewDelivery = {
      outboxEventId: fixture.delivery.outboxEventId,
      payloadChecksum: 'f'.repeat(64),
    };
    await expect(
      claimPreviewDelivery(workerPool, {
        delivery: forged,
        leaseDurationSeconds: 30,
        previewAttemptId: fixture.previewAttemptId,
        previewRunId: fixture.previewRunId,
        workerId: 'worker-preview-d',
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(PreviewDeliveryMismatchError);

    const facts = await scopedQuery(
      `select count(*)::text as count from app.transport_security_audit_facts
       where workspace_id=$1 and message_id=$2`,
      [workspaceId, fixture.delivery.outboxEventId],
    );
    expect(facts.rows[0]).toEqual({ count: '1' });
  });
}
