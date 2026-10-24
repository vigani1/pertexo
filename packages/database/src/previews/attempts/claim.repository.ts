import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { previewRuns, previewAttempts } from '../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { appendPreviewTerminalFacts } from './facts.repository.js';
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
  const db = drizzle(client);
  const attempt = await db
    .update(previewAttempts)
    .set({
      status: 'timed_out',
      safeErrorCode,
      startedAt: sql`coalesce(${previewAttempts.startedAt},clock_timestamp())`,
      completedAt: sql`clock_timestamp()`,
      leaseOwner: null,
      leaseExpiresAt: null,
      fenceToken: sql`${previewAttempts.fenceToken}+1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(previewAttempts.workspaceId, input.workspaceId),
        eq(previewAttempts.id, input.previewAttemptId),
        eq(previewAttempts.previewRunId, input.previewRunId),
        inArray(previewAttempts.status, ['queued', 'running']),
      ),
    )
    .returning({ id: previewAttempts.id })
    .catch(rethrowQueryFailure);
  if (attempt.length !== 1)
    throw new PreviewAttemptStateError('deadline_transition_lost');
  const run = await db
    .update(previewRuns)
    .set({
      status: 'timed_out',
      safeErrorCode,
      startedAt: sql`coalesce(${previewRuns.startedAt},clock_timestamp())`,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(previewRuns.workspaceId, input.workspaceId),
        eq(previewRuns.id, input.previewRunId),
        inArray(previewRuns.status, ['queued', 'running']),
      ),
    )
    .returning({ id: previewRuns.id })
    .catch(rethrowQueryFailure);
  if (run.length !== 1) throw new PreviewAttemptStateError('run_sync_lost');
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
        if (TERMINAL_PREVIEW_STATUSES.has(state.attemptStatus)) {
          await completePreviewReceipt(
            client,
            previewConsumerName,
            parsed.workspaceId,
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
          state.dispatchMarkedAt !== null &&
          state.sideEffectClass === 'unsafe';
        if (unsafeDispatch)
          throw new PreviewAttemptStateError('expired_after_dispatch');

        if (state.runDeadlineExpired) {
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
          availableAt: claimedRow.leaseExpiresAt,
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
  const db = drizzle(client);
  const claimed = await db
    .update(previewAttempts)
    .set({
      status: 'running',
      leaseOwner: parsed.workerId,
      leaseExpiresAt: sql`least(clock_timestamp()+(${parsed.leaseDurationSeconds}::int*interval '1 second'),${previewRuns.executionDeadlineAt})`,
      fenceToken: sql`${previewAttempts.fenceToken}+1`,
      startedAt: sql`coalesce(${previewAttempts.startedAt},clock_timestamp())`,
      updatedAt: sql`clock_timestamp()`,
    })
    .from(previewRuns)
    .where(
      and(
        eq(previewAttempts.workspaceId, parsed.workspaceId),
        eq(previewAttempts.id, parsed.previewAttemptId),
        eq(previewAttempts.previewRunId, parsed.previewRunId),
        inArray(previewAttempts.status, ['queued', 'running']),
        eq(previewRuns.workspaceId, previewAttempts.workspaceId),
        eq(previewRuns.id, previewAttempts.previewRunId),
        sql`${previewRuns.executionDeadlineAt}>clock_timestamp()`,
      ),
    )
    .returning({
      fenceToken: previewAttempts.fenceToken,
      leaseExpiresAt: sql<Date>`${previewAttempts.leaseExpiresAt}`.mapWith(
        previewAttempts.leaseExpiresAt,
      ),
    })
    .catch(rethrowQueryFailure);
  const claimedRow = claimed[0];
  if (claimedRow === undefined)
    throw new PreviewAttemptStateError('claim_lost');
  await db
    .update(previewRuns)
    .set({
      status: 'running',
      startedAt: sql`coalesce(${previewRuns.startedAt},clock_timestamp())`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(previewRuns.workspaceId, parsed.workspaceId),
        eq(previewRuns.id, parsed.previewRunId),
        eq(previewRuns.status, 'queued'),
      ),
    )
    .catch(rethrowQueryFailure);
  const lease = await loadPreviewLease(client, {
    attemptFenceToken: claimedRow.fenceToken,
    previewAttemptId: parsed.previewAttemptId,
    previewRunId: parsed.previewRunId,
    workspaceId: parsed.workspaceId,
  });

  return { claimedRow, lease };
}
