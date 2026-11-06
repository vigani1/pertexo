import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { withPlatformTransaction } from '@pertexo/database/platform';
import {
  rethrowQueryFailure,
  withWorkspaceScope,
} from '@pertexo/database/primitives';
import { runFailureNotificationIntents as intents } from '@pertexo/database/schema';
import { failureNotificationCompletionAuditFactType } from './completion-policy.js';
import type { FailureNotificationClaimResult } from '../failure-notification.types.js';
import { FailureNotificationStateError } from '../failure-notification.errors.js';
import {
  auditFailureNotification,
  insertFailureNotificationDeliveryOutbox,
} from './evidence.repository.js';

const recoveryBounds = z.object({
  limit: z.number().int().min(1).max(100),
  maxAttempts: z.number().int().min(1).max(10),
});
type RecoveryClaim = Readonly<{
  id: string;
  workspace_id: string;
  status: 'claimed' | 'dispatching';
  delivery_attempts: number;
  side_effect_class: Extract<
    FailureNotificationClaimResult,
    { kind: 'ready' }
  >['sideEffectClass'];
  possibly_dispatched: boolean | null;
}>;
type RecoveryDecision = Readonly<{
  safeErrorCode: string;
  deliveryUnresolved: boolean;
}> &
  (
    | Readonly<{ kind: 'retry' }>
    | Readonly<{ kind: 'terminal'; status: 'outcome_unknown' | 'dead_letter' }>
  );

/** Global queue authority claims rows; all product writes use their existing workspace fence. */
export function recoverFailureNotifications(
  pool: Pool,
  limit: number,
  maxAttempts: number,
  signal?: AbortSignal,
): Promise<number> {
  const bounds = recoveryBounds.parse({ limit, maxAttempts });
  return withPlatformTransaction(
    pool,
    async (client) => {
      const claims = await drizzle(client)
        .execute<RecoveryClaim>(
          sql`select * from app.claim_due_run_failure_notification_recoveries(${bounds.limit})`,
        )
        .catch(rethrowQueryFailure);
      for (const claim of claims.rows) {
        signal?.throwIfAborted();
        await withWorkspaceScope(
          client,
          { workspaceId: claim.workspace_id },
          (scoped) =>
            persistRecovery(
              scoped,
              claim,
              decideRecovery(claim, bounds.maxAttempts),
            ),
        );
      }
      return claims.rows.length;
    },
    signal === undefined ? {} : { signal },
  );
}

function decideRecovery(
  claim: RecoveryClaim,
  maxAttempts: number,
): RecoveryDecision {
  const dispatching = claim.status === 'dispatching';
  const deliveryUnresolved =
    (claim.possibly_dispatched ?? false) || dispatching;
  if (dispatching && claim.side_effect_class === 'unsafe')
    return {
      kind: 'terminal',
      status: 'outcome_unknown',
      safeErrorCode: 'delivery.recovery_ambiguous',
      deliveryUnresolved,
    };
  if (claim.delivery_attempts >= maxAttempts) {
    const uncertain =
      claim.side_effect_class === 'idempotent_with_key' && deliveryUnresolved;
    return {
      kind: 'terminal',
      status: uncertain ? 'outcome_unknown' : 'dead_letter',
      safeErrorCode: uncertain
        ? 'delivery.attempts_exhausted_unknown'
        : 'delivery.attempts_exhausted',
      deliveryUnresolved,
    };
  }
  return {
    kind: 'retry',
    safeErrorCode: dispatching
      ? 'delivery.recovery_ambiguous'
      : 'delivery.recovery_predispatch',
    deliveryUnresolved,
  };
}

async function persistRecovery(
  client: PoolClient,
  claim: RecoveryClaim,
  decision: RecoveryDecision,
): Promise<void> {
  const db = drizzle(client);
  const [updated] = await db
    .update(intents)
    .set({
      status: decision.kind === 'retry' ? 'retry' : decision.status,
      dispatchMarkedAt: null,
      recoveryAt: null,
      nextDeliveryAt: decision.kind === 'retry' ? sql`clock_timestamp()` : null,
      completedAt: decision.kind === 'terminal' ? sql`clock_timestamp()` : null,
      safeErrorCode: decision.safeErrorCode,
      possiblyDispatched: decision.deliveryUnresolved,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(intents.workspaceId, claim.workspace_id),
        eq(intents.id, claim.id),
        eq(intents.status, claim.status),
        eq(intents.deliveryAttempts, claim.delivery_attempts),
      ),
    )
    .returning({
      nextDeliveryAt: sql<Date | null>`${intents.nextDeliveryAt}`.mapWith(
        (value: string | null) => (value === null ? null : new Date(value)),
      ),
    })
    .catch(rethrowQueryFailure);
  if (updated === undefined)
    throw new FailureNotificationStateError('Recovery claim lost its intent');
  if (decision.kind === 'retry') {
    if (updated.nextDeliveryAt === null)
      throw new FailureNotificationStateError('Recovery retry has no due time');
    await insertFailureNotificationDeliveryOutbox(client, {
      workspaceId: claim.workspace_id,
      intentId: claim.id,
      attemptNumber: claim.delivery_attempts + 1,
      availableAt: updated.nextDeliveryAt,
    });
  }
  await auditFailureNotification(client, {
    workspaceId: claim.workspace_id,
    intentId: claim.id,
    factType:
      decision.kind === 'retry'
        ? 'retry_scheduled'
        : failureNotificationCompletionAuditFactType(decision.status),
    attemptNumber: claim.delivery_attempts,
    safeErrorCode: decision.safeErrorCode,
    possiblyDispatched: decision.deliveryUnresolved,
  });
}
