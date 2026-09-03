import type { Pool } from 'pg';
import { FailureNotificationDeliveryResultV1Schema } from '@pertexo/workflow-model/failure-notification';

import { FailureNotificationStateError } from './failure-notification-errors.js';
import {
  auditFailureNotification,
  failureNotificationIdentitySchema,
  insertFailureNotificationDeliveryOutbox,
} from './failure-notification-store-support.js';
import type { FailureNotificationStore } from './failure-notifications.js';
import { withTenantScopedClient } from './tenant-access/workspace.js';

type CompletionStore = Pick<FailureNotificationStore, 'completeDelivery'>;

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
      return withTenantScopedClient(pool, { workspaceId }, async (client) => {
        const locked = await client.query<{
          delivery_attempts: number;
          possibly_dispatched: boolean | null;
          side_effect_class: 'safe' | 'idempotent_with_key' | 'unsafe';
          status: string;
        }>(
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
        const actuallyDispatched =
          row.status === 'dispatching' && result.possiblyDispatched;
        const deliveryUnresolved =
          row.possibly_dispatched === true || actuallyDispatched;
        const retryRequested =
          result.kind === 'retry' ||
          (row.side_effect_class !== 'unsafe' &&
            result.kind === 'outcome_unknown');
        const safeUnsafeRetry =
          row.side_effect_class !== 'unsafe' ||
          (result.kind === 'retry' && !actuallyDispatched);
        const mayRetry =
          retryRequested &&
          safeUnsafeRetry &&
          raw.attemptNumber < raw.maxAttempts;
        if (mayRetry) {
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
              result.safeErrorCode ?? null,
              deliveryUnresolved,
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
            ...(result.safeErrorCode === undefined
              ? {}
              : { safeErrorCode: result.safeErrorCode }),
            possiblyDispatched: deliveryUnresolved,
          });
          return 'completed' as const;
        }
        const terminalStatus =
          result.kind === 'delivered'
            ? 'delivered'
            : actuallyDispatched ||
                result.kind === 'outcome_unknown' ||
                (row.side_effect_class === 'idempotent_with_key' &&
                  deliveryUnresolved)
              ? 'outcome_unknown'
              : 'dead_letter';
        await client.query(
          `update app.run_failure_notification_intents
           set status=$3,dispatch_marked_at=null,recovery_at=null,next_delivery_at=null,
               safe_error_code=$4,possibly_dispatched=$5,provider_reference=$6,
               completed_at=clock_timestamp(),updated_at=clock_timestamp()
           where workspace_id=$1 and id=$2`,
          [
            workspaceId,
            intentId,
            terminalStatus,
            result.safeErrorCode ?? null,
            deliveryUnresolved,
            result.providerReference ?? null,
          ],
        );
        await auditFailureNotification(client, {
          workspaceId,
          intentId,
          factType:
            terminalStatus === 'delivered'
              ? 'delivered'
              : terminalStatus === 'outcome_unknown'
                ? 'outcome_unknown'
                : 'dead_lettered',
          attemptNumber: raw.attemptNumber,
          ...(result.safeErrorCode === undefined
            ? {}
            : { safeErrorCode: result.safeErrorCode }),
          possiblyDispatched: deliveryUnresolved,
        });
        return 'completed' as const;
      });
    },
  });
}
