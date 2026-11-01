import { createHash } from 'node:crypto';

import {
  rethrowQueryFailure,
  serializeStoredExecutionJsonValue,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import {
  inboxReceipts,
  outboxEvents,
  runFailureNotificationIntents as intents,
} from '@pertexo/database/schema';
import { FailureNotificationContextSchema } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import { DELIVERY_CONSUMER } from '../../outbox/delivery-consumers.js';
import type {
  ClaimDeliveryInput,
  FailureNotificationClaimResult,
  FailureNotificationDelivery,
} from '../contract.js';
import { FailureNotificationStateError } from '../errors.js';
import { auditFailureNotification as audit } from './evidence.repository.js';

export function claimDelivery(
  pool: Pool,
  input: ClaimDeliveryInput,
): Promise<FailureNotificationClaimResult> {
  const { workspaceId, intentId, delivery, maxAttempts } = input;
  return withTenantScopedClient(
    pool,
    { workspaceId },
    async (client): Promise<FailureNotificationClaimResult> => {
      await assertNotificationDelivery(client, {
        workspaceId,
        intentId,
        delivery,
      });
      const db = drizzle(client);
      // From this commit on the intent's own recovery time owns the delivery, and a
      // retry is a new event, so this one has done its job whatever the claim finds.
      await db
        .insert(inboxReceipts)
        .values({
          consumerName: DELIVERY_CONSUMER['deliver-run-failure-notification'],
          messageId: delivery.outboxEventId,
          workspaceId,
          payloadChecksum: delivery.payloadChecksum,
          completedAt: sql`clock_timestamp()`,
        })
        .onConflictDoNothing()
        .catch(rethrowQueryFailure);
      const predicate = and(
        eq(intents.workspaceId, workspaceId),
        eq(intents.id, intentId),
      );
      const row = await readFailureIntent(client, { workspaceId, intentId });
      // Run retention takes the intent and leaves the outbox row, so a late copy of
      // the job has nothing left to deliver.
      if (
        row === undefined ||
        ['delivered', 'dead_letter', 'outcome_unknown'].includes(row.status)
      )
        return Object.freeze({ kind: 'terminal' as const });
      if (row.status === 'claimed' || row.status === 'dispatching')
        return Object.freeze({ kind: 'busy' as const });
      const retryNotDue =
        row.status === 'retry' &&
        (row.next_delivery_at === null || !row.retry_due);
      if (retryNotDue) return Object.freeze({ kind: 'busy' as const });
      if (row.delivery_attempts >= maxAttempts) {
        const unresolved =
          row.side_effect_class === 'idempotent_with_key' &&
          (row.possibly_dispatched ?? false);
        const terminalStatus = unresolved ? 'outcome_unknown' : 'dead_letter';
        const safeErrorCode = unresolved
          ? 'delivery.attempts_exhausted_unknown'
          : 'delivery.attempts_exhausted';
        await db
          .update(intents)
          .set({
            status: terminalStatus,
            dispatchMarkedAt: null,
            recoveryAt: null,
            nextDeliveryAt: null,
            safeErrorCode,
            possiblyDispatched: unresolved,
            completedAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(predicate)
          .catch(rethrowQueryFailure);
        await audit(client, {
          workspaceId,
          intentId,
          factType: unresolved ? 'outcome_unknown' : 'dead_lettered',
          attemptNumber: row.delivery_attempts,
          safeErrorCode,
          possiblyDispatched: unresolved,
        });
        return Object.freeze({ kind: 'terminal' as const });
      }
      const invalidPendingAttempt =
        (row.status !== 'pending' && row.status !== 'retry') ||
        (row.status === 'pending' && row.delivery_attempts !== 0);
      if (invalidPendingAttempt)
        throw new FailureNotificationStateError('Intent lifecycle is corrupt');
      const prepared = prepareNotificationClaim(row);
      const { attemptNumber } = prepared;
      const marked = await db
        .update(intents)
        .set({
          status: 'claimed',
          deliveryAttempts: attemptNumber,
          dispatchMarkedAt: null,
          recoveryAt: sql`clock_timestamp()+make_interval(secs=>${input.recoverySeconds})`,
          nextDeliveryAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(predicate, eq(intents.status, row.status)))
        .returning({ id: intents.id })
        .catch(rethrowQueryFailure);
      if (marked.length !== 1) return Object.freeze({ kind: 'busy' as const });
      return readyNotificationClaim(row, intentId, prepared);
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
}

type FailureIntentRow = NonNullable<
  Awaited<ReturnType<typeof readFailureIntent>>
>;
async function readFailureIntent(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; intentId: string }>,
) {
  const [row] = await drizzle(client)
    .select({
      context: intents.context,
      context_checksum: intents.contextChecksum,
      delivery_attempts: intents.deliveryAttempts,
      destination_id: intents.destinationId,
      destination_config_version: intents.destinationConfigVersion,
      side_effect_class: intents.sideEffectClass,
      status: intents.status,
      next_delivery_at: intents.nextDeliveryAt,
      connection_secret_version_id: intents.connectionSecretVersionId,
      dispatched_secret_version_id: intents.dispatchedSecretVersionId,
      delivery_binding: intents.deliveryBinding,
      possibly_dispatched: intents.possiblyDispatched,
      retry_due: sql<boolean>`(${intents.nextDeliveryAt} is not null and ${intents.nextDeliveryAt}<=clock_timestamp())`,
    })
    .from(intents)
    .where(
      and(
        eq(intents.workspaceId, input.workspaceId),
        eq(intents.id, input.intentId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return row;
}
async function assertNotificationDelivery(
  client: PoolClient,
  {
    workspaceId,
    intentId,
    delivery,
  }: Readonly<{
    workspaceId: string;
    intentId: string;
    delivery: FailureNotificationDelivery;
  }>,
): Promise<void> {
  const [outbox] = await drizzle(client)
    .select({
      aggregate_id: outboxEvents.aggregateId,
      aggregate_type: outboxEvents.aggregateType,
      job_name: outboxEvents.jobName,
      payload: outboxEvents.payload,
      payload_checksum: outboxEvents.payloadChecksum,
    })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.workspaceId, workspaceId),
        eq(outboxEvents.id, delivery.outboxEventId),
      ),
    )
    .catch(rethrowQueryFailure);
  const actualChecksum =
    outbox === undefined
      ? undefined
      : createHash('sha256')
          .update(serializeStoredExecutionJsonValue(outbox.payload))
          .digest('hex');
  const invalidDelivery =
    outbox?.aggregate_id !== intentId ||
    outbox.aggregate_type !== 'run-failure-notification' ||
    outbox.job_name !== 'deliver-run-failure-notification' ||
    outbox.payload_checksum !== delivery.payloadChecksum ||
    actualChecksum !== delivery.payloadChecksum;
  if (invalidDelivery)
    throw new FailureNotificationStateError('Delivery identity mismatch');
}
function prepareNotificationClaim(row: FailureIntentRow) {
  const context = FailureNotificationContextSchema.parse(row.context);
  const checksum = createHash('sha256')
    .update(serializeStoredExecutionJsonValue(context))
    .digest('hex');
  if (checksum !== row.context_checksum)
    throw new FailureNotificationStateError('Intent checksum mismatch');
  const attemptNumber = row.delivery_attempts + 1;
  const connectionSecretVersionId =
    row.dispatched_secret_version_id ?? row.connection_secret_version_id;
  // Missing persisted evidence must retain the worker's retry behavior.
  if (connectionSecretVersionId === null)
    throw new Error('Intent credential pin is missing');

  return { context, attemptNumber, connectionSecretVersionId };
}
function readyNotificationClaim(
  row: FailureIntentRow,
  intentId: string,
  {
    context,
    attemptNumber,
    connectionSecretVersionId,
  }: ReturnType<typeof prepareNotificationClaim>,
): Extract<FailureNotificationClaimResult, { kind: 'ready' }> {
  return Object.freeze({
    kind: 'ready' as const,
    attemptNumber,
    context,
    destinationId: row.destination_id,
    destinationConfigVersion: row.destination_config_version,
    sideEffectClass: row.side_effect_class,
    idempotencyKey: `failure-notification:${intentId}`,
    connectionSecretVersionId,
    deliveryUnresolved: row.possibly_dispatched ?? false,
    ...(row.delivery_binding === null
      ? {}
      : {
          deliveryBinding: row.delivery_binding,
        }),
  });
}
