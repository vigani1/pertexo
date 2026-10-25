import {
  failureNotificationCompletionAuditFactType,
  failureNotificationCompletionDecision,
} from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { runFailureNotificationIntents as intents } from '../../schema/runs/completion/notifications.js';

import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import type { FailureNotificationStore } from '../contract.js';
import { FailureNotificationStateError } from '../errors.js';
import {
  auditFailureNotification,
  insertFailureNotificationDeliveryOutbox,
} from './evidence.repository.js';

type CompletionStore = Pick<FailureNotificationStore, 'completeDelivery'>;
function lockedCompletion(
  db: Pick<NodePgDatabase, 'select'>,
  input: Readonly<{ workspaceId: string; intentId: string }>,
) {
  return db
    .select({
      status: intents.status,
      delivery_attempts: intents.deliveryAttempts,
      side_effect_class: intents.sideEffectClass,
      possibly_dispatched: intents.possiblyDispatched,
    })
    .from(intents)
    .where(
      and(
        eq(intents.workspaceId, input.workspaceId),
        eq(intents.id, input.intentId),
      ),
    )
    .for('update');
}
export function createFailureNotificationCompletionStore(
  pool: Pool,
): CompletionStore {
  return Object.freeze({
    completeDelivery: async (
      raw: Parameters<FailureNotificationStore['completeDelivery']>[0],
    ) => {
      const workspaceId = raw.workspaceId;
      const intentId = raw.intentId;
      const result = raw.result;
      const attemptNumber = raw.attemptNumber;
      const maxAttempts = raw.maxAttempts;
      const retryDelaySeconds = raw.retryDelaySeconds;
      const safeErrorCode =
        result.kind === 'delivered' ? undefined : result.safeErrorCode;
      const providerReference =
        result.kind === 'delivered' ? result.providerReference : undefined;
      return withTenantScopedClient(
        pool,
        { workspaceId },
        async (client) => {
          const db = drizzle(client);
          const predicate = and(
            eq(intents.workspaceId, workspaceId),
            eq(intents.id, intentId),
          );
          const [row] = await lockedCompletion(db, { workspaceId, intentId });
          const staleDeliveryAttempt =
            (row?.status !== 'claimed' && row?.status !== 'dispatching') ||
            row.delivery_attempts !== attemptNumber;
          if (staleDeliveryAttempt) return 'stale' as const;
          const invalidDispatchEvidence =
            row.status === 'claimed' &&
            (result.kind === 'delivered' ||
              (result.kind === 'outcome_unknown' &&
                !(row.possibly_dispatched ?? false)));
          if (invalidDispatchEvidence)
            throw new FailureNotificationStateError(
              'Predispatch completion result is incompatible',
            );
          const decision = failureNotificationCompletionDecision(
            row,
            result,
            attemptNumber,
            maxAttempts,
          );
          if (decision.kind === 'retry') {
            if (retryDelaySeconds === 0)
              throw new FailureNotificationStateError(
                'Retry delay must be positive when scheduling a retry',
              );
            const [scheduled] = await db
              .update(intents)
              .set({
                status: 'retry',
                dispatchMarkedAt: null,
                recoveryAt: null,
                nextDeliveryAt: sql`clock_timestamp()+make_interval(secs=>${retryDelaySeconds})`,
                safeErrorCode: safeErrorCode ?? null,
                possiblyDispatched: decision.deliveryUnresolved,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(predicate)
              .returning({
                nextDeliveryAt: sql<Date>`${intents.nextDeliveryAt}`.mapWith(
                  (value: string) => new Date(value),
                ),
              })
              .catch(rethrowQueryFailure);
            const due = scheduled?.nextDeliveryAt;
            if (due === undefined)
              throw new FailureNotificationStateError(
                'Retry schedule was not persisted',
              );
            await insertFailureNotificationDeliveryOutbox(client, {
              workspaceId,
              intentId,
              attemptNumber: attemptNumber + 1,
              availableAt: due,
            });
            await auditFailureNotification(client, {
              workspaceId,
              intentId,
              factType: 'retry_scheduled',
              attemptNumber,
              ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
              possiblyDispatched: decision.deliveryUnresolved,
            });
            return 'completed' as const;
          }
          await db
            .update(intents)
            .set({
              status: decision.status,
              dispatchMarkedAt: null,
              recoveryAt: null,
              nextDeliveryAt: null,
              safeErrorCode: safeErrorCode ?? null,
              possiblyDispatched: decision.deliveryUnresolved,
              providerReference: providerReference ?? null,
              completedAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(predicate)
            .catch(rethrowQueryFailure);
          await auditFailureNotification(client, {
            workspaceId,
            intentId,
            factType: failureNotificationCompletionAuditFactType(
              decision.status,
            ),
            attemptNumber,
            ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
            possiblyDispatched: decision.deliveryUnresolved,
          });
          return 'completed' as const;
        },
        raw.signal === undefined ? {} : { signal: raw.signal },
      );
    },
  });
}
