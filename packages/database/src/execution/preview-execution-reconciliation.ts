import type { Pool } from 'pg';
import { z } from 'zod';

import { PREVIEW_STATUS } from './preview-execution-acceptance.js';
import { appendPreviewTerminalFacts } from './preview-execution-completion.js';
import {
  TERMINAL_PREVIEW_STATUSES,
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
  optionsFor,
  previewPairConsistent,
  previewReconcilerConsumerName,
  type PreviewDelivery,
} from './preview-execution-contract.js';
import {
  auditPreviewDeliveryMismatch,
  claimPreviewReceipt,
  completePreviewReceipt,
  insertPreviewOutboxDelivery,
  validatePreviewReconciliationDelivery,
} from './preview-execution-delivery.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionValueV1,
  type StoredExecutionValueV1,
} from './stored-execution-value.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';

export type PreviewReconciliationOutcome = Readonly<{
  status: typeof PREVIEW_STATUS.outcomeUnknown;
}>;

export type PreviewDeliveryReconciliationResult =
  | Readonly<{ kind: 'duplicate' }>
  | Readonly<{
      kind: 'rescheduled';
      reconciliationOutboxEventId: string;
    }>
  | Readonly<{
      executionOutboxEventId: string;
      kind: 'redelivered';
    }>
  | Readonly<{
      kind: 'completed';
      mayContactProvider: boolean;
      mayCauseExternalSideEffect: boolean;
      operationKey?: string;
      possiblyDispatched: boolean;
      providerKey?: string;
      sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
      status:
        typeof PREVIEW_STATUS.outcomeUnknown | typeof PREVIEW_STATUS.timedOut;
      usesConnection: boolean;
    }>;

/**
 * Bounded stored-value contract check for executor outputs before a
 * succeeded completion is attempted.
 */
function isStrictJsonValue(value: unknown, depth: number): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((member) => isStrictJsonValue(member, depth + 1));
  if (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.entries(value).every(
      ([key, member]) => key.length > 0 && isStrictJsonValue(member, depth + 1),
    );
  // Functions, symbols, bigints, class instances, and host objects are all
  // outside the stored-value contract.
  return false;
}

export function isValidStoredExecutionOutput(
  value: unknown,
): value is StoredExecutionValueV1 {
  if (!isStrictJsonValue(value, 0)) return false;
  try {
    // Serialization alone can silently drop hostile members; a lossless
    // canonical roundtrip additionally proves byte-stable truth.
    const serialized = serializeStoredExecutionValueV1(value);
    const reparsed = parseStoredExecutionValueV1(serialized);
    return serializeStoredExecutionValueV1(reparsed) === serialized;
  } catch {
    return false;
  }
}

export async function reconcileExpiredPreviewAttempt(
  pool: Pool,
  input: Readonly<{
    previewAttemptId: string;
    previewRunId: string;
    signal?: AbortSignal;
    workspaceId: string;
  }>,
): Promise<PreviewReconciliationOutcome> {
  const scope = z
    .object({
      previewAttemptId: z.uuid(),
      previewRunId: z.uuid(),
      workspaceId: z.uuid(),
    })
    .parse(input);
  return withTenantScopedClient(
    pool,
    { workspaceId: scope.workspaceId },
    async (client): Promise<PreviewReconciliationOutcome> => {
      const locked = await client.query<{
        attempt_status: string;
        dispatch_marked_at: Date | null;
        expired_or_absent: boolean;
        side_effect_class: string;
      }>(
        `select attempt.status as attempt_status,
                attempt.dispatch_marked_at,
                attempt.side_effect_class,
                (attempt.lease_expires_at is null
                   or attempt.lease_expires_at <= clock_timestamp())
                  as expired_or_absent
         from app.preview_attempts attempt
         where attempt.workspace_id=$1
           and attempt.id=$2
           and attempt.preview_run_id=$3
         for update`,
        [scope.workspaceId, scope.previewAttemptId, scope.previewRunId],
      );
      const state = locked.rows[0];
      if (state === undefined)
        throw new PreviewAttemptStateError('attempt_not_found');
      if (state.attempt_status === PREVIEW_STATUS.outcomeUnknown)
        return Object.freeze({ status: PREVIEW_STATUS.outcomeUnknown });
      if (state.attempt_status !== 'running' || !state.expired_or_absent)
        throw new PreviewAttemptStateError('reconciliation_not_applicable');
      // Undispatched, safe, and stable-key work is reclaimable under ADR 007
      // and must not be rewritten as a terminal failure. The original
      // identifier-only delivery may claim it again after lease expiry.
      if (
        state.dispatch_marked_at === null ||
        state.side_effect_class !== 'unsafe'
      )
        throw new PreviewAttemptStateError('reconciliation_reclaim_required');
      const status = PREVIEW_STATUS.outcomeUnknown;
      const reconciliationRef = {
        schemaVersion: 1,
        reason: 'lease_expired_after_unsafe_dispatch',
      };
      const applied = await client.query<{ id: string }>(
        `update app.preview_attempts
         set status=$4::varchar,
             safe_error_code=$5::varchar,
             reconciliation_ref=$6::jsonb,
             completed_at=clock_timestamp(),
             lease_owner=null,
             lease_expires_at=null,
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and preview_run_id=$3
           and status='running'
         returning id`,
        [
          scope.workspaceId,
          scope.previewAttemptId,
          scope.previewRunId,
          status,
          'preview.outcome_unknown',
          JSON.stringify(reconciliationRef),
        ],
      );
      if (applied.rowCount !== 1)
        throw new PreviewAttemptStateError('reconciliation_lost');
      const syncedRuns = await client.query<{ id: string }>(
        `update app.preview_runs
         set status=$3::varchar,
             safe_error_code=$4::varchar,
             completed_at=clock_timestamp(),
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and status in ('queued','running')
         returning id`,
        [
          scope.workspaceId,
          scope.previewRunId,
          status,
          'preview.outcome_unknown',
        ],
      );
      if (syncedRuns.rowCount !== 1)
        throw new PreviewAttemptStateError('run_sync_lost');
      await appendPreviewTerminalFacts(client, {
        previewAttemptId: scope.previewAttemptId,
        previewRunId: scope.previewRunId,
        status,
        workspaceId: scope.workspaceId,
      });
      return Object.freeze({ status });
    },
    optionsFor(input.signal),
  );
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
  const scope = z
    .object({
      attemptFenceToken: z.number().int().nonnegative(),
      previewAttemptId: z.uuid(),
      previewRunId: z.uuid(),
      workspaceId: z.uuid(),
    })
    .parse(input);
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

        const locked = await client.query<{
          attempt_status: string;
          dispatch_marked_at: Date | null;
          fence_token: string;
          lease_live: boolean;
          lease_expires_at: Date | null;
          may_contact_provider: boolean;
          may_cause_external_side_effect: boolean;
          operation_key: string | null;
          provider_key: string | null;
          run_deadline_expired: boolean;
          run_status: string;
          side_effect_class: string;
          uses_connection: boolean;
        }>(
          `select attempt.status as attempt_status,
                  attempt.dispatch_marked_at,
                  attempt.fence_token,
                  attempt.lease_expires_at,
                  (attempt.lease_expires_at is not null and
                   attempt.lease_expires_at > clock_timestamp()) as lease_live,
                   attempt.side_effect_class,
                   run.may_contact_provider,
                   run.may_cause_external_side_effect,
                   run.operation_key,
                   run.provider_key,
                   coalesce(
                     jsonb_typeof(run.executable_node_json->'connectionRefs') = 'object'
                     and run.executable_node_json->'connectionRefs' <> '{}'::jsonb,
                     false
                   )
                     as uses_connection,
                   run.status as run_status,
                  (run.execution_deadline_at <= clock_timestamp()) as run_deadline_expired
           from app.preview_attempts attempt
           join app.preview_runs run
             on run.workspace_id=attempt.workspace_id
            and run.id=attempt.preview_run_id
           where attempt.workspace_id=$1
             and attempt.id=$2
             and attempt.preview_run_id=$3
           for update of attempt,run`,
          [scope.workspaceId, scope.previewAttemptId, scope.previewRunId],
        );
        const state = locked.rows[0];
        if (state === undefined)
          throw new PreviewAttemptStateError('attempt_not_found');
        if (!previewPairConsistent(state.attempt_status, state.run_status))
          throw new PreviewAttemptStateError('run_attempt_divergence');

        const completeReceipt = async (): Promise<void> =>
          completePreviewReceipt(
            client,
            previewReconcilerConsumerName,
            scope.workspaceId,
            input.delivery,
          );
        if (
          TERMINAL_PREVIEW_STATUSES.has(state.attempt_status) ||
          state.attempt_status !== PREVIEW_STATUS.running ||
          Number(state.fence_token) !== scope.attemptFenceToken
        ) {
          await completeReceipt();
          return Object.freeze({ kind: 'duplicate' });
        }

        if (state.lease_live) {
          if (state.lease_expires_at === null)
            throw new PreviewAttemptStateError('lease_shape_invalid');
          const successor = await insertPreviewOutboxDelivery(client, {
            attemptFenceToken: scope.attemptFenceToken,
            availableAt: state.lease_expires_at,
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
          state.dispatch_marked_at !== null &&
          state.side_effect_class === 'unsafe';
        const runDeadlineExpired = state.run_deadline_expired;
        if (unsafePossiblyDispatched || runDeadlineExpired) {
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
            schemaVersion: 1,
            reason,
            attemptFenceToken: scope.attemptFenceToken,
          });
          const attempt = await client.query(
            `update app.preview_attempts
             set status=$4,
                 safe_error_code=$5,
                 reconciliation_ref=$6::jsonb,
                 completed_at=clock_timestamp(),
                 lease_owner=null,
                 lease_expires_at=null,
                 fence_token=fence_token+1,
                 updated_at=clock_timestamp()
             where workspace_id=$1 and id=$2 and preview_run_id=$3
               and status='running' and fence_token=$7`,
            [
              scope.workspaceId,
              scope.previewAttemptId,
              scope.previewRunId,
              status,
              safeErrorCode,
              reconciliationRef,
              scope.attemptFenceToken,
            ],
          );
          if (attempt.rowCount !== 1)
            throw new PreviewAttemptStateError('reconciliation_lost');
          const run = await client.query(
            `update app.preview_runs
             set status=$3,
                 safe_error_code=$4,
                 completed_at=clock_timestamp(),
                 updated_at=clock_timestamp()
             where workspace_id=$1 and id=$2
               and status in ('queued','running')`,
            [scope.workspaceId, scope.previewRunId, status, safeErrorCode],
          );
          if (run.rowCount !== 1)
            throw new PreviewAttemptStateError('run_sync_lost');
          await appendPreviewTerminalFacts(client, {
            previewAttemptId: scope.previewAttemptId,
            previewRunId: scope.previewRunId,
            status,
            workspaceId: scope.workspaceId,
          });
          await completeReceipt();
          return Object.freeze({
            kind: 'completed',
            mayContactProvider: state.may_contact_provider,
            mayCauseExternalSideEffect: state.may_cause_external_side_effect,
            ...(state.operation_key === null
              ? {}
              : { operationKey: state.operation_key }),
            possiblyDispatched: state.dispatch_marked_at !== null,
            ...(state.provider_key === null
              ? {}
              : { providerKey: state.provider_key }),
            sideEffectClass: z
              .enum(['safe', 'idempotent_with_key', 'unsafe'])
              .parse(state.side_effect_class),
            status,
            usesConnection: state.uses_connection,
          });
        }

        // Fence the expired owner before making the replacement delivery
        // visible. The stable provider key and prior dispatch marker remain
        // pinned for safe/idempotent repetition under ADR 007.
        const reclaimed = await client.query(
          `update app.preview_attempts
           set status='queued',
               lease_owner=null,
               lease_expires_at=null,
               fence_token=fence_token+1,
               reconciliation_ref=$4::jsonb,
               updated_at=clock_timestamp()
           where workspace_id=$1 and id=$2 and preview_run_id=$3
             and status='running' and fence_token=$5`,
          [
            scope.workspaceId,
            scope.previewAttemptId,
            scope.previewRunId,
            JSON.stringify({
              schemaVersion: 1,
              reason: 'lease_expired_redelivery',
              attemptFenceToken: scope.attemptFenceToken,
            }),
            scope.attemptFenceToken,
          ],
        );
        if (reclaimed.rowCount !== 1)
          throw new PreviewAttemptStateError('reconciliation_lost');
        const queuedRun = await client.query(
          `update app.preview_runs
           set status='queued',updated_at=clock_timestamp()
           where workspace_id=$1 and id=$2 and status='running'`,
          [scope.workspaceId, scope.previewRunId],
        );
        if (queuedRun.rowCount !== 1)
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
      },
      optionsFor(input.signal),
    );
  } catch (error: unknown) {
    if (
      error instanceof PreviewDeliveryMismatchError &&
      !input.signal?.aborted
    ) {
      await auditPreviewDeliveryMismatch(
        pool,
        previewReconcilerConsumerName,
        scope.workspaceId,
        input.delivery,
        input.signal ?? new AbortController().signal,
      );
    }
    throw error;
  }
}
