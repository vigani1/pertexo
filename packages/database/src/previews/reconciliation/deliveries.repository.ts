import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  PreviewDeliveryReconciliationResult,
  PreviewReconciliationScope,
} from './contract.js';
import { lockPreviewReconciliationState } from './state.queries.js';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { previewAttempts, previewRuns } from '../../schema/runs/execution.js';

import {
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
  type StoredExecutionValue,
} from '../../platform/stored-execution-value.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import {
  auditPreviewDeliveryMismatch,
  claimPreviewReceipt,
  completePreviewReceipt,
  insertPreviewOutboxDelivery,
  validatePreviewReconciliationDelivery,
} from '../attempts/deliveries.repository.js';
import { appendPreviewTerminalFacts } from '../attempts/facts.repository.js';
import type { PreviewDelivery } from '../contract.js';
import { previewReconcilerConsumerName } from '../delivery.js';
import {
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
} from '../errors.js';
import { optionsFor } from '../input.js';
import { PREVIEW_STATUS, TERMINAL_PREVIEW_STATUSES } from '../state.js';

type LockedPreviewReconciliationState = Awaited<
  ReturnType<typeof lockPreviewReconciliationState>
>;

export function isValidStoredExecutionOutput(
  value: unknown,
): value is StoredExecutionValue {
  try {
    // The descriptor-based stored-value module is the single admission
    // contract. It rejects accessors, proxies and lossy JSON shapes without
    // invoking caller-controlled properties, then proves canonical stability.
    const serialized = serializeStoredExecutionValue(value);
    const reparsed = parseStoredExecutionValue(serialized);
    return serializeStoredExecutionValue(reparsed) === serialized;
  } catch {
    return false;
  }
}

async function completeExpiredOrUnsafePreview(
  client: PoolClient,
  scope: PreviewReconciliationScope,
  state: LockedPreviewReconciliationState,
  completeReceipt: () => Promise<void>,
): Promise<
  Extract<PreviewDeliveryReconciliationResult, { kind: 'completed' }>
> {
  const unsafePossiblyDispatched =
    state.dispatchMarkedAt !== null && state.sideEffectClass === 'unsafe';
  const status = unsafePossiblyDispatched
    ? PREVIEW_STATUS.outcomeUnknown
    : PREVIEW_STATUS.timedOut;
  const safeErrorCode = unsafePossiblyDispatched
    ? 'preview.outcome_unknown'
    : 'preview.deadline_exceeded';
  const reason = unsafePossiblyDispatched
    ? 'lease_expired_after_unsafe_dispatch'
    : 'run_deadline_expired_before_reclaim';
  const reconciliationRef = JSON.stringify({
    reason,
    attemptFenceToken: scope.attemptFenceToken,
  });
  const db = drizzle(client);
  const attempt = await db
    .update(previewAttempts)
    .set({
      status,
      safeErrorCode,
      reconciliationRef: sql`${reconciliationRef}::jsonb`,
      completedAt: sql`clock_timestamp()`,
      leaseOwner: null,
      leaseExpiresAt: null,
      fenceToken: sql`${previewAttempts.fenceToken}+1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(previewAttempts.workspaceId, scope.workspaceId),
        eq(previewAttempts.id, scope.previewAttemptId),
        eq(previewAttempts.previewRunId, scope.previewRunId),
        eq(previewAttempts.status, 'running'),
        eq(previewAttempts.fenceToken, scope.attemptFenceToken),
      ),
    )
    .returning({ id: previewAttempts.id })
    .catch(rethrowQueryFailure);
  if (attempt.length !== 1)
    throw new PreviewAttemptStateError('reconciliation_lost');
  const run = await db
    .update(previewRuns)
    .set({
      status,
      safeErrorCode,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(previewRuns.workspaceId, scope.workspaceId),
        eq(previewRuns.id, scope.previewRunId),
        inArray(previewRuns.status, ['queued', 'running']),
      ),
    )
    .returning({ id: previewRuns.id })
    .catch(rethrowQueryFailure);
  if (run.length !== 1) throw new PreviewAttemptStateError('run_sync_lost');
  await appendPreviewTerminalFacts(client, {
    previewAttemptId: scope.previewAttemptId,
    previewRunId: scope.previewRunId,
    status,
    workspaceId: scope.workspaceId,
  });
  await completeReceipt();
  return Object.freeze({
    kind: 'completed',
    mayContactProvider: state.mayContactProvider,
    mayCauseExternalSideEffect: state.mayCauseExternalSideEffect,
    ...(state.operationKey === null
      ? {}
      : { operationKey: state.operationKey }),
    possiblyDispatched: state.dispatchMarkedAt !== null,
    ...(state.providerKey === null ? {} : { providerKey: state.providerKey }),
    sideEffectClass: state.sideEffectClass,
    status,
    usesConnection: state.usesConnection,
  });
}

/**
 * Handles one durable reconciliation wake-up for a specific lease fence.
 * Every non-duplicate decision, its successor outbox delivery, and its inbox
 * receipt commit atomically so Redis/BullMQ never becomes the authority.
 */
export async function reconcilePreviewDelivery(
  pool: Pool,
  input: Readonly<{
    attemptFenceToken: number;
    delivery: PreviewDelivery;
    previewAttemptId: string;
    previewRunId: string;
    signal?: AbortSignal;
    workspaceId: string;
  }>,
): Promise<PreviewDeliveryReconciliationResult> {
  const scope = input;
  try {
    return await withTenantScopedClient(
      pool,
      { workspaceId: scope.workspaceId },
      async (client): Promise<PreviewDeliveryReconciliationResult> => {
        const payload = await validatePreviewReconciliationDelivery(client, {
          attemptFenceToken: scope.attemptFenceToken,
          delivery: input.delivery,
          previewAttemptId: scope.previewAttemptId,
          previewRunId: scope.previewRunId,
          workspaceId: scope.workspaceId,
        });
        if (
          (await claimPreviewReceipt(
            client,
            previewReconcilerConsumerName,
            scope.workspaceId,
            input.delivery,
          )) === 'completed'
        )
          return Object.freeze({ kind: 'duplicate' });

        const state = await lockPreviewReconciliationState(client, scope);
        const completeReceipt = async (): Promise<void> =>
          completePreviewReceipt(
            client,
            previewReconcilerConsumerName,
            scope.workspaceId,
            input.delivery,
          );
        const staleReconciliation =
          TERMINAL_PREVIEW_STATUSES.has(state.attemptStatus) ||
          state.attemptStatus !== PREVIEW_STATUS.running ||
          state.fenceToken !== scope.attemptFenceToken;
        if (staleReconciliation) {
          await completeReceipt();
          return Object.freeze({ kind: 'duplicate' });
        }

        if (state.leaseLive) {
          if (state.leaseExpiresAt === null)
            throw new PreviewAttemptStateError('lease_shape_invalid');
          const successor = await insertPreviewOutboxDelivery(client, {
            attemptFenceToken: scope.attemptFenceToken,
            availableAt: state.leaseExpiresAt,
            jobName: 'reconcile-preview-attempt',
            previewAttemptId: scope.previewAttemptId,
            previewRunId: scope.previewRunId,
            ...(payload.traceparent === undefined
              ? {}
              : { traceparent: payload.traceparent }),
            workspaceId: scope.workspaceId,
          });
          await completeReceipt();
          return Object.freeze({
            kind: 'rescheduled',
            reconciliationOutboxEventId: successor.outboxEventId,
          });
        }

        const unsafePossiblyDispatched =
          state.dispatchMarkedAt !== null && state.sideEffectClass === 'unsafe';
        const runDeadlineExpired = state.runDeadlineExpired;
        if (unsafePossiblyDispatched || runDeadlineExpired)
          return completeExpiredOrUnsafePreview(
            client,
            scope,
            state,
            completeReceipt,
          );

        return redeliverExpiredPreview(client, scope, {
          payload,
          completeReceipt,
        });
      },
      optionsFor(input.signal),
    );
  } catch (error: unknown) {
    if (
      error instanceof PreviewDeliveryMismatchError &&
      !input.signal?.aborted
    ) {
      await auditPreviewDeliveryMismatch(pool, previewReconcilerConsumerName, {
        workspaceId: scope.workspaceId,
        delivery: input.delivery,
        signal: input.signal ?? new AbortController().signal,
      });
    }
    throw error;
  }
}

async function redeliverExpiredPreview(
  client: PoolClient,
  scope: PreviewReconciliationScope,
  {
    payload,
    completeReceipt,
  }: Readonly<{
    payload: Awaited<ReturnType<typeof validatePreviewReconciliationDelivery>>;
    completeReceipt: () => Promise<void>;
  }>,
): Promise<
  Extract<PreviewDeliveryReconciliationResult, { kind: 'redelivered' }>
> {
  // Fence the expired owner before making the replacement delivery
  // visible. The stable provider key and prior dispatch marker remain
  // pinned for safe/idempotent repetition under ADR 007.
  const db = drizzle(client);
  const reclaimed = await db
    .update(previewAttempts)
    .set({
      status: 'queued',
      leaseOwner: null,
      leaseExpiresAt: null,
      fenceToken: sql`${previewAttempts.fenceToken}+1`,
      reconciliationRef: sql`${JSON.stringify({ reason: 'lease_expired_redelivery', attemptFenceToken: scope.attemptFenceToken })}::jsonb`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(previewAttempts.workspaceId, scope.workspaceId),
        eq(previewAttempts.id, scope.previewAttemptId),
        eq(previewAttempts.previewRunId, scope.previewRunId),
        eq(previewAttempts.status, 'running'),
        eq(previewAttempts.fenceToken, scope.attemptFenceToken),
      ),
    )
    .returning({ id: previewAttempts.id })
    .catch(rethrowQueryFailure);
  if (reclaimed.length !== 1)
    throw new PreviewAttemptStateError('reconciliation_lost');
  const queuedRun = await db
    .update(previewRuns)
    .set({ status: 'queued', updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(previewRuns.workspaceId, scope.workspaceId),
        eq(previewRuns.id, scope.previewRunId),
        eq(previewRuns.status, 'running'),
      ),
    )
    .returning({ id: previewRuns.id })
    .catch(rethrowQueryFailure);
  if (queuedRun.length !== 1)
    throw new PreviewAttemptStateError('run_sync_lost');
  const execution = await insertPreviewOutboxDelivery(client, {
    jobName: 'execute-preview-attempt',
    previewAttemptId: scope.previewAttemptId,
    previewRunId: scope.previewRunId,
    ...(payload.traceparent === undefined
      ? {}
      : { traceparent: payload.traceparent }),
    workspaceId: scope.workspaceId,
  });
  await completeReceipt();
  return Object.freeze({
    executionOutboxEventId: execution.outboxEventId,
    kind: 'redelivered',
  });
}
