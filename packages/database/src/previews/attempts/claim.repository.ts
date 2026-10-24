import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { appendPreviewTerminalFacts } from './completion.repository.js';
import {
  TERMINAL_PREVIEW_STATUSES,
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
  optionsFor,
  previewConsumerName,
  type PreviewAttemptLease,
  type PreviewDelivery,
} from '../contract.js';
import {
  auditPreviewDeliveryMismatch,
  claimPreviewReceipt,
  completePreviewReceipt,
  insertPreviewOutboxDelivery,
  validatePreviewDelivery,
} from './deliveries.repository.js';

import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import {
  loadPreviewLease,
  lockPreviewClaimState,
} from './claim/state.queries.js';

export type PreviewClaimResult =
  | Readonly<{ kind: 'claimed'; lease: PreviewAttemptLease }>
  | Readonly<{ kind: 'duplicate' }>;

async function terminalizeExpiredPreview(
  client: PoolClient,
  input: Readonly<{
    delivery: PreviewDelivery;
    previewAttemptId: string;
    previewRunId: string;
    workspaceId: string;
  }>,
): Promise<void> {
  const safeErrorCode = 'preview.deadline_exceeded';
  const attempt = await client.query(
    `update app.preview_attempts
     set status='timed_out',safe_error_code=$4,
         started_at=coalesce(started_at,clock_timestamp()),
         completed_at=clock_timestamp(),lease_owner=null,
         lease_expires_at=null,fence_token=fence_token+1,
         updated_at=clock_timestamp()
     where workspace_id=$1 and id=$2 and preview_run_id=$3
       and status in ('queued','running')`,
    [
      input.workspaceId,
      input.previewAttemptId,
      input.previewRunId,
      safeErrorCode,
    ],
  );
  if (attempt.rowCount !== 1)
    throw new PreviewAttemptStateError('deadline_transition_lost');
  const run = await client.query(
    `update app.preview_runs
     set status='timed_out',safe_error_code=$3,
         started_at=coalesce(started_at,clock_timestamp()),
         completed_at=clock_timestamp(),updated_at=clock_timestamp()
     where workspace_id=$1 and id=$2
       and status in ('queued','running')`,
    [input.workspaceId, input.previewRunId, safeErrorCode],
  );
  if (run.rowCount !== 1) throw new PreviewAttemptStateError('run_sync_lost');
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
  input: Readonly<{
    delivery: PreviewDelivery;
    leaseDurationSeconds: number;
    previewAttemptId: string;
    previewRunId: string;
    signal?: AbortSignal;
    workerId: string;
    workspaceId: string;
  }>,
): Promise<PreviewClaimResult> {
  const parsed = z
    .object({
      leaseDurationSeconds: z.number().int().positive().max(3_600),
      previewAttemptId: z.uuid(),
      previewRunId: z.uuid(),
      workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
      workspaceId: z.uuid(),
    })
    .parse(input);
  try {
    return await withTenantScopedClient(
      pool,
      { workspaceId: parsed.workspaceId },
      async (client): Promise<PreviewClaimResult> => {
        await validatePreviewDelivery(client, {
          delivery: input.delivery,
          previewAttemptId: parsed.previewAttemptId,
          previewRunId: parsed.previewRunId,
          workspaceId: parsed.workspaceId,
        });

        // A prior claim may have crashed before completing business work;
        // durable attempt state below decides whether redelivery may proceed.
        // The receipt completes only together with a terminal outcome.
        if (
          (await claimPreviewReceipt(
            client,
            previewConsumerName,
            parsed.workspaceId,
            input.delivery,
          )) === 'completed'
        )
          return Object.freeze({ kind: 'duplicate' });

        const state = await lockPreviewClaimState(client, parsed);
        if (TERMINAL_PREVIEW_STATUSES.has(state.attempt_status)) {
          await completePreviewReceipt(
            client,
            previewConsumerName,
            parsed.workspaceId,
            input.delivery,
          );
          return Object.freeze({ kind: 'duplicate' });
        }
        const leaseStillLive =
          state.attempt_status === 'running' && (state.live_lease ?? false);
        if (leaseStillLive) {
          // Another live worker owns the single logical attempt; at-least-once
          // transport makes this delivery a concurrent duplicate.
          return Object.freeze({ kind: 'duplicate' });
        }
        const unsafeDispatch =
          state.attempt_status === 'running' &&
          state.dispatch_marked_at !== null &&
          state.side_effect_class === 'unsafe';
        if (unsafeDispatch)
          throw new PreviewAttemptStateError('expired_after_dispatch');

        if (state.run_deadline_expired) {
          await terminalizeExpiredPreview(client, {
            delivery: input.delivery,
            previewAttemptId: parsed.previewAttemptId,
            previewRunId: parsed.previewRunId,
            workspaceId: parsed.workspaceId,
          });
          return Object.freeze({ kind: 'duplicate' });
        }

        const { claimedRow, lease } = await claimPreviewLease(client, parsed);
        // The lease and its reconciliation wake-up commit together. Redis is
        // only delivery acceleration: an unpublished delayed outbox row
        // remains authoritative through queue loss or worker termination.
        await insertPreviewOutboxDelivery(client, {
          attemptFenceToken: lease.attemptFenceToken,
          availableAt: claimedRow.lease_expires_at,
          jobName: 'reconcile-preview-attempt',
          previewAttemptId: parsed.previewAttemptId,
          previewRunId: parsed.previewRunId,
          ...(lease.traceparent === undefined
            ? {}
            : { traceparent: lease.traceparent }),
          workspaceId: parsed.workspaceId,
        });
        return Object.freeze({ kind: 'claimed', lease });
      },
      optionsFor(input.signal),
    );
  } catch (error: unknown) {
    if (
      error instanceof PreviewDeliveryMismatchError &&
      !input.signal?.aborted
    ) {
      // A mismatched delivery is a durable tenant-scoped security fact. It
      // is written in its own transaction because the business transaction
      // above rolled back with the failure.
      await auditPreviewDeliveryMismatch(pool, previewConsumerName, {
        workspaceId: parsed.workspaceId,
        delivery: input.delivery,
        signal: input.signal ?? new AbortController().signal,
      });
    }
    throw error;
  }
}

async function claimPreviewLease(
  client: PoolClient,
  parsed: Pick<
    Parameters<typeof claimPreviewDelivery>[1],
    | 'workspaceId'
    | 'previewAttemptId'
    | 'previewRunId'
    | 'workerId'
    | 'leaseDurationSeconds'
  >,
) {
  const claimed = await client.query<{
    fence_token: number;
    lease_expires_at: Date;
  }>(
    `update app.preview_attempts
         set status='running',
             lease_owner=$4,
             lease_expires_at=least(
               clock_timestamp() + ($5::int * interval '1 second'),
               run.execution_deadline_at
             ),
             fence_token=preview_attempts.fence_token + 1,
             started_at=coalesce(
               preview_attempts.started_at,
               clock_timestamp()
             ),
             updated_at=clock_timestamp()
         from app.preview_runs run
         where preview_attempts.workspace_id=$1
           and preview_attempts.id=$2
           and preview_attempts.preview_run_id=$3
           and preview_attempts.status in ('queued','running')
           and run.workspace_id=preview_attempts.workspace_id
           and run.id=preview_attempts.preview_run_id
           and run.execution_deadline_at > clock_timestamp()
         returning preview_attempts.fence_token,
                   preview_attempts.lease_expires_at`,
    [
      parsed.workspaceId,
      parsed.previewAttemptId,
      parsed.previewRunId,
      parsed.workerId,
      parsed.leaseDurationSeconds,
    ],
  );
  const claimedRow = claimed.rows[0];
  if (claimedRow === undefined)
    throw new PreviewAttemptStateError('claim_lost');
  await client.query(
    `update app.preview_runs
         set status='running',
             started_at=coalesce(started_at, clock_timestamp()),
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and status='queued'`,
    [parsed.workspaceId, parsed.previewRunId],
  );
  const lease = await loadPreviewLease(client, {
    attemptFenceToken: claimedRow.fence_token,
    previewAttemptId: parsed.previewAttemptId,
    previewRunId: parsed.previewRunId,
    workspaceId: parsed.workspaceId,
  });

  return { claimedRow, lease };
}
