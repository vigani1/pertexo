import { requireActivePreviewWorkspace } from './workspace-fence.repository.js';
import type { Pool, PoolClient } from 'pg';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import type {
  ClaimPreviewDeliveryInput,
  PreviewClaimResult,
} from './preview-attempt.types.js';

import type { PreviewDelivery } from '../preview.types.js';
import { previewConsumerName } from '../delivery.js';
import { PreviewAttemptStateError } from '../preview.errors.js';
import {
  mayHaveDispatchedUnsafely,
  TERMINAL_PREVIEW_STATUSES,
} from '../preview-state.js';
import {
  auditingDeliveryMismatch,
  claimPreviewReceipt,
  completePreviewReceipt,
  insertPreviewOutboxDelivery,
  validatePreviewDelivery,
} from './deliveries.repository.js';
import { appendPreviewTerminalFacts } from './facts.repository.js';
import {
  leasePreviewAttempt,
  markPreviewRunStarted,
} from './lease.repository.js';
import {
  timeOutPreviewAttempt,
  timeOutPreviewRun,
} from './outcomes.repository.js';

import {
  loadPreviewLease,
  lockPreviewClaimState,
} from './preview-claim.repository.js';

async function terminalizeExpiredPreview(
  client: PoolClient,
  input: Readonly<{
    delivery: PreviewDelivery;
    previewAttemptId: string;
    previewRunId: string;
    workspaceId: string;
  }>,
): Promise<void> {
  if (!(await timeOutPreviewAttempt(client, input)))
    throw new PreviewAttemptStateError('deadline_transition_lost');
  if (!(await timeOutPreviewRun(client, input)))
    throw new PreviewAttemptStateError('run_sync_lost');
  await appendPreviewTerminalFacts(client, {
    previewAttemptId: input.previewAttemptId,
    previewRunId: input.previewRunId,
    status: 'timed_out',
    workspaceId: input.workspaceId,
  });
  await completePreviewReceipt(
    client,
    previewConsumerName,
    input.workspaceId,
    input.delivery,
  );
}

export async function claimPreviewDelivery(
  pool: Pool,
  input: ClaimPreviewDeliveryInput,
): Promise<PreviewClaimResult> {
  return auditingDeliveryMismatch(
    pool,
    previewConsumerName,
    {
      workspaceId: input.workspaceId,
      delivery: input.delivery,
      signal: input.signal,
    },
    () =>
      withTenantScopedClient(
        pool,
        { workspaceId: input.workspaceId },
        async (client): Promise<PreviewClaimResult> => {
          await requireActivePreviewWorkspace(client, input.workspaceId);
          await validatePreviewDelivery(client, {
            delivery: input.delivery,
            previewAttemptId: input.previewAttemptId,
            previewRunId: input.previewRunId,
            workspaceId: input.workspaceId,
          });

          // A prior claim may have crashed before completing business work;
          // durable attempt state below decides whether redelivery may proceed.
          // The receipt completes only together with a terminal outcome.
          if (
            (await claimPreviewReceipt(
              client,
              previewConsumerName,
              input.workspaceId,
              input.delivery,
            )) === 'completed'
          )
            return Object.freeze({ kind: 'duplicate' });

          const state = await lockPreviewClaimState(client, input);
          if (TERMINAL_PREVIEW_STATUSES.has(state.attemptStatus)) {
            await completePreviewReceipt(
              client,
              previewConsumerName,
              input.workspaceId,
              input.delivery,
            );
            return Object.freeze({ kind: 'duplicate' });
          }
          const leaseStillLive =
            state.attemptStatus === 'running' && state.liveLease;
          if (leaseStillLive) {
            // Another live worker owns the single logical attempt; at-least-once
            // transport makes this delivery a concurrent duplicate.
            return Object.freeze({ kind: 'duplicate' });
          }
          const unsafeDispatch =
            state.attemptStatus === 'running' &&
            mayHaveDispatchedUnsafely(state);
          if (unsafeDispatch)
            throw new PreviewAttemptStateError('expired_after_dispatch');

          if (state.runDeadlineExpired) {
            await terminalizeExpiredPreview(client, {
              delivery: input.delivery,
              previewAttemptId: input.previewAttemptId,
              previewRunId: input.previewRunId,
              workspaceId: input.workspaceId,
            });
            return Object.freeze({ kind: 'duplicate' });
          }

          const { claimedRow, lease } = await claimPreviewLease(client, input);
          // The lease and its reconciliation wake-up commit together. Redis is
          // only delivery acceleration: an unpublished delayed outbox row
          // remains authoritative through queue loss or worker termination.
          await insertPreviewOutboxDelivery(client, {
            attemptFenceToken: lease.attemptFenceToken,
            availableAt: claimedRow.leaseExpiresAt,
            jobName: 'reconcile-preview-attempt',
            previewAttemptId: input.previewAttemptId,
            previewRunId: input.previewRunId,
            ...(lease.traceparent === undefined
              ? {}
              : { traceparent: lease.traceparent }),
            workspaceId: input.workspaceId,
          });
          return Object.freeze({ kind: 'claimed', lease });
        },
        input,
      ),
  );
}

async function claimPreviewLease(
  client: PoolClient,
  parsed: Pick<
    ClaimPreviewDeliveryInput,
    | 'workspaceId'
    | 'previewAttemptId'
    | 'previewRunId'
    | 'workerId'
    | 'leaseDurationSeconds'
  >,
) {
  const claimedRow = await leasePreviewAttempt(client, parsed);
  if (claimedRow === undefined)
    throw new PreviewAttemptStateError('claim_lost');
  await markPreviewRunStarted(client, parsed);
  const lease = await loadPreviewLease(client, {
    attemptFenceToken: claimedRow.fenceToken,
    previewAttemptId: parsed.previewAttemptId,
    previewRunId: parsed.previewRunId,
    workspaceId: parsed.workspaceId,
  });

  return { claimedRow, lease };
}
