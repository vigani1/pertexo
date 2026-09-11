import type { Pool } from 'pg';
import { FailureNotificationDeliveryResultV1Schema } from '@pertexo/workflow-model/failure-notification';

import { FailureNotificationStateError } from './failure-notification-errors.js';
import {
  auditFailureNotification,
  failureNotificationIdentitySchema,
  insertFailureNotificationDeliveryOutbox,
} from './failure-notification-store-support.js';
import type { FailureNotificationStore } from './failure-notification-contracts.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';

type CompletionStore = Pick<FailureNotificationStore, 'completeDelivery'>;
type DeliveryResult = ReturnType<
  typeof FailureNotificationDeliveryResultV1Schema.parse
>;
type LockedIntent = Readonly<{
  delivery_attempts: number;
  possibly_dispatched: boolean | null;
  side_effect_class: 'safe' | 'idempotent_with_key' | 'unsafe';
  status: string;
}>;
type CompletionDecision =
  | Readonly<{ kind: 'retry'; deliveryUnresolved: boolean }>
  | Readonly<{
      kind: 'terminal';
      deliveryUnresolved: boolean;
      status: 'delivered' | 'outcome_unknown' | 'dead_letter';
    }>;
type TerminalCompletionStatus = Extract<
  CompletionDecision,
  { readonly kind: 'terminal' }
>['status'];

function terminalCompletionStatus(
  row: LockedIntent,
  result: DeliveryResult,
  actuallyDispatched: boolean,
  deliveryUnresolved: boolean,
): TerminalCompletionStatus {
  if (result.kind === 'delivered') return 'delivered';
  if (actuallyDispatched || result.kind === 'outcome_unknown')
    return 'outcome_unknown';
  if (row.side_effect_class === 'idempotent_with_key' && deliveryUnresolved)
    return 'outcome_unknown';
  return 'dead_letter';
}

function completionAuditFactType(
  status: TerminalCompletionStatus,
): 'delivered' | 'outcome_unknown' | 'dead_lettered' {
  if (status === 'delivered') return 'delivered';
  if (status === 'outcome_unknown') return 'outcome_unknown';
  return 'dead_lettered';
}

function completionDecision(
  row: LockedIntent,
  result: DeliveryResult,
  attemptNumber: number,
  maxAttempts: number,
): CompletionDecision {
  const actuallyDispatched =
    row.status === 'dispatching' && result.possiblyDispatched;
  const deliveryUnresolved =
    row.possibly_dispatched === true || actuallyDispatched;
  const retryRequested =
    result.kind === 'retry' ||
    (row.side_effect_class !== 'unsafe' && result.kind === 'outcome_unknown');
  const unsafeRetryIsKnownNotDispatched =
    row.side_effect_class !== 'unsafe' ||
    (result.kind === 'retry' && !actuallyDispatched);
  if (
    retryRequested &&
    unsafeRetryIsKnownNotDispatched &&
    attemptNumber < maxAttempts
  )
    return { kind: 'retry', deliveryUnresolved };
  const status = terminalCompletionStatus(
    row,
    result,
    actuallyDispatched,
    deliveryUnresolved,
  );
  return { kind: 'terminal', deliveryUnresolved, status };
}

export function createFailureNotificationCompletionStore(
  pool: Pool,
): CompletionStore {
  return Object.freeze({
    completeDelivery: async (
      raw: Parameters<FailureNotificationStore['completeDelivery']>[0],
    ) => {
      const workspaceId = failureNotificationIdentitySchema.parse(
        raw.workspaceId,
      );
      const intentId = failureNotificationIdentitySchema.parse(raw.intentId);
      const result = FailureNotificationDeliveryResultV1Schema.parse(
        raw.result,
      );
      const safeErrorCode =
        result.kind === 'delivered' ? undefined : result.safeErrorCode;
      const providerReference =
        result.kind === 'delivered' ? result.providerReference : undefined;
      return withTenantScopedClient(pool, { workspaceId }, async (client) => {
        const locked = await client.query<LockedIntent>(
          `select status,delivery_attempts,side_effect_class,possibly_dispatched
           from app.run_failure_notification_intents
           where workspace_id=$1 and id=$2 for update`,
          [workspaceId, intentId],
        );
        const row = locked.rows[0];
        if (
          (row?.status !== 'claimed' && row?.status !== 'dispatching') ||
          row.delivery_attempts !== raw.attemptNumber
        )
          return 'stale' as const;
        if (
          row.status === 'claimed' &&
          (result.kind === 'delivered' ||
            (result.kind === 'outcome_unknown' &&
              row.possibly_dispatched !== true))
        )
          throw new FailureNotificationStateError(
            'Predispatch completion result is incompatible',
          );
        const decision = completionDecision(
          row,
          result,
          raw.attemptNumber,
          raw.maxAttempts,
        );
        if (decision.kind === 'retry') {
          const scheduled = await client.query<{ next_delivery_at: Date }>(
            `update app.run_failure_notification_intents
             set status='retry',dispatch_marked_at=null,recovery_at=null,
                  next_delivery_at=clock_timestamp()+make_interval(secs=>$3),
                  safe_error_code=$4,possibly_dispatched=$5,updated_at=clock_timestamp()
             where workspace_id=$1 and id=$2
             returning next_delivery_at`,
            [
              workspaceId,
              intentId,
              raw.retryDelaySeconds,
              safeErrorCode ?? null,
              decision.deliveryUnresolved,
            ],
          );
          const due = scheduled.rows[0]?.next_delivery_at;
          if (due === undefined)
            throw new FailureNotificationStateError(
              'Retry schedule was not persisted',
            );
          await insertFailureNotificationDeliveryOutbox(client, {
            workspaceId,
            intentId,
            attemptNumber: raw.attemptNumber + 1,
            availableAt: due,
          });
          await auditFailureNotification(client, {
            workspaceId,
            intentId,
            factType: 'retry_scheduled',
            attemptNumber: raw.attemptNumber,
            ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
            possiblyDispatched: decision.deliveryUnresolved,
          });
          return 'completed' as const;
        }
        await client.query(
          `update app.run_failure_notification_intents
           set status=$3,dispatch_marked_at=null,recovery_at=null,next_delivery_at=null,
               safe_error_code=$4,possibly_dispatched=$5,provider_reference=$6,
               completed_at=clock_timestamp(),updated_at=clock_timestamp()
           where workspace_id=$1 and id=$2`,
          [
            workspaceId,
            intentId,
            decision.status,
            safeErrorCode ?? null,
            decision.deliveryUnresolved,
            providerReference ?? null,
          ],
        );
        await auditFailureNotification(client, {
          workspaceId,
          intentId,
          factType: completionAuditFactType(decision.status),
          attemptNumber: raw.attemptNumber,
          ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
          possiblyDispatched: decision.deliveryUnresolved,
        });
        return 'completed' as const;
      });
    },
  });
}
