import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  systemMailDeliveries as mail,
  runFailureNotificationIntents as intents,
} from '@pertexo/database/schema';
import { auditFailureNotification } from './evidence.repository.js';
import { failureNotificationCompletionAuditFactType } from './completion-policy.js';

/** A durable provider result, rather than enqueue, completes a shared alert. */
export async function reconcileSystemMail(
  client: PoolClient,
  claim: Readonly<{
    id: string;
    workspace_id: string;
    delivery_attempts: number;
  }>,
): Promise<boolean> {
  const db = drizzle(client);
  const [delivery] = await db
    .select({ status: mail.status, failureCode: mail.failureCode })
    .from(mail)
    .where(
      and(eq(mail.id, claim.id), eq(mail.purpose, 'workflow_failure_alert')),
    );
  if (delivery === undefined) return false;
  const scope = and(
    eq(intents.workspaceId, claim.workspace_id),
    eq(intents.id, claim.id),
  );
  if (['queued', 'retry', 'outcome_unknown'].includes(delivery.status)) {
    await db
      .update(intents)
      .set({
        recoveryAt: sql`clock_timestamp()+interval '60 seconds'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(scope);
    return true;
  }
  let status: 'delivered' | 'outcome_unknown' | 'dead_letter' = 'dead_letter';
  if (delivery.status === 'submitted') status = 'delivered';
  else if (delivery.status === 'reconciliation_required')
    status = 'outcome_unknown';
  const possiblyDispatched = status !== 'dead_letter';
  const safeErrorCode = delivery.failureCode ?? undefined;
  await db
    .update(intents)
    .set({
      status,
      recoveryAt: null,
      nextDeliveryAt: null,
      dispatchMarkedAt: null,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
      safeErrorCode: delivery.failureCode,
      possiblyDispatched,
      providerReference:
        status === 'delivered' ? `system-mail:${claim.id}` : null,
    })
    .where(scope);
  await auditFailureNotification(client, {
    workspaceId: claim.workspace_id,
    intentId: claim.id,
    attemptNumber: claim.delivery_attempts,
    factType: failureNotificationCompletionAuditFactType(status),
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    possiblyDispatched,
  });
  return true;
}
