import {
  withTenantScopedClient,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import { serializeStoredExecutionJsonValue } from '../../runs/values/stored-execution.js';
import type { NodeAttemptRunStore } from '../contract.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  outboxEvents,
  inboxReceipts,
  transportSecurityAuditFacts,
} from '@pertexo/database/schema';
import { createHash } from 'node:crypto';
import { generatePersistedId } from '@pertexo/database/platform';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import {
  DeliveryMismatch,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptStateCorruptError,
} from '../errors.js';
import { attemptJobPayloadSchema } from '../validation/delivery.js';
import type { NodeAttemptDelivery } from '../contract.js';
import { DELIVERY_CONSUMER } from '../../outbox/delivery-consumers.js';

export const nodeAttemptConsumerName =
  DELIVERY_CONSUMER['execute-node-attempt'];

export async function validateDelivery(
  client: PoolClient,
  input: Parameters<NodeAttemptRunStore['claimDelivery']>[0],
): Promise<void> {
  const result = await drizzle(client)
    .select({
      aggregateId: outboxEvents.aggregateId,
      aggregateType: outboxEvents.aggregateType,
      jobName: outboxEvents.jobName,
      payload: outboxEvents.payload,
      payloadChecksum: outboxEvents.payloadChecksum,
    })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.workspaceId, input.workspaceId),
        eq(outboxEvents.id, input.delivery.outboxEventId),
      ),
    )
    .catch(rethrowQueryFailure);
  const row = result[0];
  let payload: z.output<typeof attemptJobPayloadSchema> | undefined;
  let checksum: string | undefined;
  try {
    payload = attemptJobPayloadSchema.parse(row?.payload);
    checksum = createHash('sha256')
      .update(serializeStoredExecutionJsonValue(payload))
      .digest('hex');
  } catch {
    throw new DeliveryMismatch();
  }
  const invalidDelivery =
    row?.aggregateId !== input.attemptId ||
    row.aggregateType !== 'node-attempt' ||
    row.jobName !== 'execute-node-attempt' ||
    row.payloadChecksum !== input.delivery.payloadChecksum ||
    checksum !== row.payloadChecksum ||
    payload.workspaceId !== input.workspaceId ||
    payload.runId !== input.runId ||
    payload.nodeRunId !== input.nodeRunId ||
    payload.attemptId !== input.attemptId ||
    payload.outboxEventId !== input.delivery.outboxEventId;
  if (invalidDelivery) throw new DeliveryMismatch();
}

export async function claimReceipt(
  client: PoolClient,
  workspaceId: string,
  delivery: NodeAttemptDelivery,
): Promise<'new' | 'incomplete' | 'completed'> {
  const db = drizzle(client);
  const inserted = await db
    .insert(inboxReceipts)
    .values({
      consumerName: nodeAttemptConsumerName,
      messageId: delivery.outboxEventId,
      workspaceId,
      payloadChecksum: delivery.payloadChecksum,
    })
    .onConflictDoNothing({
      target: [inboxReceipts.consumerName, inboxReceipts.messageId],
    })
    .returning({ messageId: inboxReceipts.messageId })
    .catch(rethrowQueryFailure);
  if (inserted.length === 1) return 'new';
  const existing = await db
    .select({
      completedAt: inboxReceipts.completedAt,
      payloadChecksum: inboxReceipts.payloadChecksum,
    })
    .from(inboxReceipts)
    .where(
      and(
        eq(inboxReceipts.consumerName, nodeAttemptConsumerName),
        eq(inboxReceipts.messageId, delivery.outboxEventId),
        eq(inboxReceipts.workspaceId, workspaceId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const receipt = existing[0];
  if (receipt === undefined) throw new NodeAttemptStateCorruptError();
  if (receipt.payloadChecksum !== delivery.payloadChecksum)
    throw new DeliveryMismatch();
  return receipt.completedAt === null ? 'incomplete' : 'completed';
}

export async function completeReceipt(
  client: PoolClient,
  workspaceId: string,
  delivery: NodeAttemptDelivery,
): Promise<void> {
  const result = await drizzle(client)
    .update(inboxReceipts)
    .set({ completedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(inboxReceipts.consumerName, nodeAttemptConsumerName),
        eq(inboxReceipts.messageId, delivery.outboxEventId),
        eq(inboxReceipts.workspaceId, workspaceId),
        eq(inboxReceipts.payloadChecksum, delivery.payloadChecksum),
        isNull(inboxReceipts.completedAt),
      ),
    )
    .returning({ messageId: inboxReceipts.messageId })
    .catch(rethrowQueryFailure);
  if (result.length !== 1) throw new NodeAttemptStateCorruptError();
}

export async function auditMismatch(
  pool: Pool,
  workspaceId: string,
  delivery: NodeAttemptDelivery,
  signal: AbortSignal,
): Promise<never> {
  await withTenantScopedClient(
    pool,
    { workspaceId },
    async (client) => {
      await drizzle(client)
        .insert(transportSecurityAuditFacts)
        .values({
          id: generatePersistedId(),
          workspaceId,
          factType: 'inbox_checksum_mismatch',
          consumerName: nodeAttemptConsumerName,
          messageId: delivery.outboxEventId,
        })
        .catch(rethrowQueryFailure);
    },
    { signal: signal },
  );
  throw new NodeAttemptDeliveryMismatchError();
}
