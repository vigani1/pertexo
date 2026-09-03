import type { Pool } from 'pg';
import { z } from 'zod';

import { executableNodeSchema } from './preview-execution-acceptance.js';
import {
  TERMINAL_PREVIEW_STATUSES,
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
  optionsFor,
  previewPairConsistent,
  previewConsumerName,
  type PreviewAttemptLease,
  type PreviewDelivery,
} from './preview-execution-contract.js';
import {
  auditPreviewDeliveryMismatch,
  claimPreviewReceipt,
  completePreviewReceipt,
  insertPreviewOutboxDelivery,
  validatePreviewDelivery,
} from './preview-execution-delivery.js';
import { parseStoredExecutionValueV1 } from './stored-execution-value.js';
import { withTenantScopedClient } from './tenant-access/workspace.js';

async function loadPreviewLease(
  client: Parameters<Parameters<typeof withTenantScopedClient>[2]>[0],
  input: Readonly<{
    attemptFenceToken: number;
    expiresAt: Date;
    previewAttemptId: string;
    previewRunId: string;
    workspaceId: string;
  }>,
): Promise<PreviewAttemptLease> {
  const runs = await client.query<
    Readonly<{
      compatibility_release_epoch: number;
      compatibility_release_fingerprint: string;
      definition_key: string;
      definition_version: number;
      dry_run: string;
      executable_node_json: unknown;
      executor_key: string;
      executor_version: number;
      input_ref: unknown;
      may_contact_provider: boolean;
      may_cause_external_side_effect: boolean;
      node_id: string;
      operation_key: string | null;
      provider_key: string | null;
      side_effect_class: string;
      traceparent: string | null;
      workflow_id: string;
    }> & { execution_deadline_at: Date; retention_expires_at: Date }
  >(
    `select compatibility_release_epoch,compatibility_release_fingerprint,
            definition_key,definition_version,dry_run,executable_node_json,
            executor_key,executor_version,input_ref,may_contact_provider,
             may_cause_external_side_effect,node_id,operation_key,provider_key,
             side_effect_class,
            traceparent,workflow_id,
            execution_deadline_at,
            expires_at as retention_expires_at
     from app.preview_runs
     where workspace_id=$1 and id=$2`,
    [input.workspaceId, input.previewRunId],
  );
  const attempts = await client.query<{
    dispatch_marked_at: Date | null;
    provider_dispatch_binding: string | null;
    provider_idempotency_key: string | null;
    side_effect_class: string;
  }>(
    `select dispatch_marked_at,provider_idempotency_key,
            provider_dispatch_binding,side_effect_class
     from app.preview_attempts
     where workspace_id=$1 and id=$2`,
    [input.workspaceId, input.previewAttemptId],
  );
  const run = runs.rows[0];
  const attempt = attempts.rows[0];
  if (run === undefined || attempt === undefined)
    throw new PreviewAttemptStateError('pins_missing');
  const sideEffectClass = z
    .enum(['safe', 'idempotent_with_key', 'unsafe'])
    .parse(attempt.side_effect_class);
  return Object.freeze({
    // PostgreSQL bigint arrives as a string through node-postgres; coerce
    // at this boundary before the numeric contract applies.
    attemptFenceToken: z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(input.attemptFenceToken),
    workspaceId: input.workspaceId,
    compatibilityReleaseEpoch: run.compatibility_release_epoch,
    compatibilityReleaseFingerprint: run.compatibility_release_fingerprint,
    definitionKey: run.definition_key,
    definitionVersion: run.definition_version,
    dryRun: z.enum(['not_supported', 'provider_supported']).parse(run.dry_run),
    executableNode: Object.freeze(
      executableNodeSchema.parse(run.executable_node_json),
    ),
    executorKey: run.executor_key,
    executorVersion: run.executor_version,
    executionDeadlineAt: run.execution_deadline_at,
    retentionExpiresAt: run.retention_expires_at,
    input: parseStoredExecutionValueV1(run.input_ref),
    mayContactProvider: run.may_contact_provider,
    mayCauseExternalSideEffect: run.may_cause_external_side_effect,
    nodeId: run.node_id,
    ...(run.operation_key === null ? {} : { operationKey: run.operation_key }),
    previewAttemptId: input.previewAttemptId,
    previewRunId: input.previewRunId,
    ...(run.provider_key === null ? {} : { providerKey: run.provider_key }),
    ...(attempt.provider_idempotency_key === null
      ? {}
      : { providerIdempotencyKey: attempt.provider_idempotency_key }),
    ...(attempt.provider_dispatch_binding === null
      ? {}
      : { providerDispatchBinding: attempt.provider_dispatch_binding }),
    ...(attempt.dispatch_marked_at === null
      ? {}
      : { providerDispatchUnresolved: true as const }),
    sideEffectClass,
    ...(run.traceparent === null ? {} : { traceparent: run.traceparent }),
    workflowId: run.workflow_id,
  });
}

export type PreviewClaimResult =
  | Readonly<{ kind: 'claimed'; lease: PreviewAttemptLease }>
  | Readonly<{ kind: 'duplicate' }>;

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

        const locked = await client.query<{
          attempt_status: string;
          dispatch_marked_at: Date | null;
          lease_expired: boolean | null;
          live_lease: boolean | null;
          run_status: string;
          side_effect_class: string;
        }>(
          `select attempt.status as attempt_status,
                attempt.dispatch_marked_at,
                attempt.side_effect_class,
                (attempt.lease_expires_at is not null
                   and attempt.lease_expires_at > clock_timestamp())
                  as live_lease,
                (attempt.lease_expires_at is not null
                   and attempt.lease_expires_at <= clock_timestamp())
                  as lease_expired,
                run.status as run_status
         from app.preview_attempts attempt
         join app.preview_runs run
           on run.workspace_id = attempt.workspace_id
          and run.id = attempt.preview_run_id
         where attempt.workspace_id=$1
           and attempt.id=$2
           and attempt.preview_run_id=$3
         for update of attempt, run`,
          [parsed.workspaceId, parsed.previewAttemptId, parsed.previewRunId],
        );
        const state = locked.rows[0];
        if (state === undefined)
          throw new PreviewAttemptStateError('attempt_not_found');
        if (!previewPairConsistent(state.attempt_status, state.run_status))
          throw new PreviewAttemptStateError('run_attempt_divergence');
        if (TERMINAL_PREVIEW_STATUSES.has(state.attempt_status)) {
          await completePreviewReceipt(
            client,
            previewConsumerName,
            parsed.workspaceId,
            input.delivery,
          );
          return Object.freeze({ kind: 'duplicate' });
        }
        if (state.attempt_status === 'running' && state.live_lease === true) {
          // Another live worker owns the single logical attempt; at-least-once
          // transport makes this delivery a concurrent duplicate.
          return Object.freeze({ kind: 'duplicate' });
        }
        if (
          state.attempt_status === 'running' &&
          state.dispatch_marked_at !== null &&
          state.side_effect_class === 'unsafe'
        )
          throw new PreviewAttemptStateError('expired_after_dispatch');

        const claimed = await client.query<{
          fence_token: number;
          lease_expires_at: Date;
        }>(
          `update app.preview_attempts
         set status='running',
             lease_owner=$4,
             lease_expires_at=clock_timestamp() + ($5::int * interval '1 second'),
             fence_token=fence_token + 1,
             started_at=coalesce(started_at, clock_timestamp()),
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and preview_run_id=$3
           and status in ('queued','running')
         returning fence_token,lease_expires_at`,
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
          expiresAt: claimedRow.lease_expires_at,
          previewAttemptId: parsed.previewAttemptId,
          previewRunId: parsed.previewRunId,
          workspaceId: parsed.workspaceId,
        });
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
      await auditPreviewDeliveryMismatch(
        pool,
        previewConsumerName,
        parsed.workspaceId,
        input.delivery,
        input.signal ?? new AbortController().signal,
      );
    }
    throw error;
  }
}
