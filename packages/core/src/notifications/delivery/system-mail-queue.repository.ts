import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { insertSystemMail } from '@pertexo/secrets/server';
import {
  failureNotificationDestinations as destinations,
  failureNotificationDestinationVersions as versions,
  runFailureNotificationIntents as intents,
  workflows,
} from '@pertexo/database/schema';
import type { FailureNotificationContext } from '@pertexo/workflow-model';
import type { FailureNotificationMailSealer } from './system-mail.types.js';
import { destinationConfigSql } from '../destinations/notification-destinations.repository.js';
import { readSystemMailRecipient } from './system-mail-recipient.repository.js';
import { auditFailureNotification } from './evidence.repository.js';

/** Queue and intent ownership commit together; the queue owns all provider retries. */
export async function queueSystemMail(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    intentId: string;
    attemptNumber: number;
    recoverySeconds: number;
    context: FailureNotificationContext;
  }>,
  seal: FailureNotificationMailSealer | undefined,
): Promise<boolean> {
  const db = drizzle(client);
  const [destination] = await db
    .select({
      config: destinationConfigSql,
      enabled: destinations.status,
      currentVersion: destinations.currentConfigVersion,
      pinnedVersion: intents.destinationConfigVersion,
      workflowName: workflows.name,
      now: sql<Date>`clock_timestamp()`.mapWith(
        (value: string) => new Date(value),
      ),
    })
    .from(intents)
    .innerJoin(
      destinations,
      and(
        eq(destinations.workspaceId, intents.workspaceId),
        eq(destinations.id, intents.destinationId),
      ),
    )
    .innerJoin(
      versions,
      and(
        eq(versions.workspaceId, intents.workspaceId),
        eq(versions.destinationId, intents.destinationId),
        eq(versions.version, intents.destinationConfigVersion),
      ),
    )
    .innerJoin(
      workflows,
      and(
        eq(workflows.workspaceId, intents.workspaceId),
        eq(workflows.id, input.context.workflowId),
      ),
    )
    .where(
      and(
        eq(intents.workspaceId, input.workspaceId),
        eq(intents.id, input.intentId),
      ),
    );
  if (destination?.config.kind !== 'system_mail') return false;
  const recipient = await readSystemMailRecipient(
    db,
    input.workspaceId,
    destination.config.memberId,
  );
  let failure: string | undefined;
  if (seal === undefined) failure = 'delivery.system_mail_unavailable';
  else if (
    destination.enabled !== 'enabled' ||
    destination.currentVersion !== destination.pinnedVersion
  )
    failure = 'failure_alert.superseded';
  else if (!recipient?.verified) failure = 'delivery.recipient_unavailable';
  if (failure !== undefined || seal === undefined || recipient === undefined) {
    const safeErrorCode = failure ?? 'delivery.recipient_unavailable';
    await db
      .update(intents)
      .set({
        status: 'dead_letter',
        deliveryAttempts: input.attemptNumber,
        recoveryAt: null,
        completedAt: sql`clock_timestamp()`,
        safeErrorCode,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(intents.id, input.intentId));
    await auditFailureNotification(client, {
      ...input,
      factType: 'dead_lettered',
      safeErrorCode,
      possiblyDispatched: false,
    });
    return true;
  }
  const expiresAt = new Date(destination.now.getTime() + 24 * 3_600_000);
  await insertSystemMail(client, {
    id: input.intentId,
    purpose: 'workflow_failure_alert',
    expiresAt,
    sealedPayload: seal({
      id: input.intentId,
      expiresAt,
      workspaceId: input.workspaceId,
      toEmail: recipient.email,
      workflowName: destination.workflowName,
      context: input.context,
    }),
  });
  await db
    .update(intents)
    .set({
      status: 'claimed',
      deliveryAttempts: input.attemptNumber,
      recoveryAt: sql`clock_timestamp()+make_interval(secs=>${input.recoverySeconds})`,
      nextDeliveryAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(intents.workspaceId, input.workspaceId),
        eq(intents.id, input.intentId),
      ),
    );
  return true;
}
