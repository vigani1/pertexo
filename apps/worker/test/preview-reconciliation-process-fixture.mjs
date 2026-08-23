/* global process */

import {
  claimPreviewDelivery,
  completePreviewAttempt,
  markPreviewDispatched,
  PREVIEW_STATUS,
} from '@pertexo/database';
import { Pool } from 'pg';

const input = JSON.parse(
  process.env.PREVIEW_RECONCILIATION_CHILD_INPUT ?? '{}',
);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const pool = new Pool({ connectionString: input.workerUrl, max: 1 });

try {
  const claimed = await claimPreviewDelivery(pool, {
    delivery: input.delivery,
    leaseDurationSeconds: input.leaseDurationSeconds,
    previewAttemptId: input.previewAttemptId,
    previewRunId: input.previewRunId,
    workerId: input.workerId,
    workspaceId: input.workspaceId,
  });
  if (claimed.kind !== 'claimed') throw new Error('child claim was duplicate');
  if (input.markDispatched === true) {
    await markPreviewDispatched(pool, {
      lease: claimed.lease,
      workerId: input.workerId,
    });
  }
  if (input.complete === true) {
    await completePreviewAttempt(pool, {
      delivery: input.delivery,
      lease: claimed.lease,
      outcome: {
        safeErrorCode: 'preview.fixture_failed',
        status: PREVIEW_STATUS.failed,
      },
      workerId: input.workerId,
    });
  }
  emit({
    attemptFenceToken: claimed.lease.attemptFenceToken,
    injectionPoint:
      input.complete === true
        ? 'preview.outcome_committed_before_queue_ack'
        : input.markDispatched === true
          ? 'preview.dispatch_committed_before_outcome'
          : 'preview.claim_committed_before_dispatch',
    pid: process.pid,
    providerIdempotencyKey: claimed.lease.providerIdempotencyKey ?? null,
  });
  await new Promise(() => undefined);
} finally {
  await pool.end();
}
