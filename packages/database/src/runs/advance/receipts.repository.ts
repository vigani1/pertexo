import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  inboxReceipts,
  outboxEvents,
  transportSecurityAuditFacts,
} from '../../schema/transport.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { createHash } from 'node:crypto';

import { generatePersistedId } from '../../platform/persisted-id.js';

import type { Pool, PoolClient } from 'pg';

import {
  CoordinatorDeliveryMismatchError,
  CoordinatorRunStateCorruptError,
} from '../state-errors.js';
import type {
  CoordinatorAdvanceDelivery,
  RunAdvanceResult,
} from './contract.js';
import { withCoordinatorWriteClient } from './transactions.repository.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import { serializeStoredExecutionJsonValue } from '../../platform/stored-execution-value.js';
import { DELIVERY_CONSUMER } from '../../outbox/delivery-consumers.js';

export const coordinatorConsumerName =
  DELIVERY_CONSUMER['advance-workflow-run'];

export class DeliveryMismatch extends Error {}

export async function validateAuthoritativeAdvanceDelivery(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  delivery: CoordinatorAdvanceDelivery,
): Promise<void> {
  const [row] = await drizzle(client)
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
  let storedChecksum: string | undefined;
  try {
    storedChecksum =
      row === undefined
        ? undefined
        : createHash('sha256')
            .update(serializeStoredExecutionJsonValue(row.payload))
            .digest('hex');
  } catch {
    throw new DeliveryMismatch();
  }
  const invalidDelivery =
    row?.aggregate_id !== runId ||
    row.aggregate_type !== 'workflow-run' ||
    row.job_name !== 'advance-workflow-run' ||
    row.payload_checksum !== delivery.payloadChecksum ||
    storedChecksum !== row.payload_checksum;
  if (invalidDelivery) throw new DeliveryMismatch();
}

export async function claimCoordinatorReceipt(
  client: PoolClient,
  workspaceId: string,
  delivery: CoordinatorAdvanceDelivery,
): Promise<'new' | 'duplicate'> {
  const db = drizzle(client),
    r = inboxReceipts;
  const inserted = await db
    .insert(r)
    .values({
      consumerName: coordinatorConsumerName,
      messageId: delivery.outboxEventId,
      workspaceId,
      payloadChecksum: delivery.payloadChecksum,
    })
    .onConflictDoNothing({ target: [r.consumerName, r.messageId] })
    .returning({ messageId: r.messageId })
    .catch(rethrowQueryFailure);
  if (inserted.length === 1) return 'new';
  const [receipt] = await db
    .select({
      completed_at: r.completedAt,
      payload_checksum: r.payloadChecksum,
    })
    .from(r)
    .where(
      and(
        eq(r.consumerName, coordinatorConsumerName),
        eq(r.messageId, delivery.outboxEventId),
        eq(r.workspaceId, workspaceId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (receipt?.completed_at == null)
    throw new CoordinatorRunStateCorruptError();
  if (receipt.payload_checksum !== delivery.payloadChecksum)
    throw new DeliveryMismatch();
  return 'duplicate';
}

export async function completeCoordinatorReceipt(
  client: PoolClient,
  workspaceId: string,
  delivery: CoordinatorAdvanceDelivery,
): Promise<void> {
  const r = inboxReceipts;
  const completed = await drizzle(client)
    .update(r)
    .set({ completedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(r.consumerName, coordinatorConsumerName),
        eq(r.messageId, delivery.outboxEventId),
        eq(r.workspaceId, workspaceId),
        eq(r.payloadChecksum, delivery.payloadChecksum),
        isNull(r.completedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  if (completed.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  await drizzle(client)
    .execute(
      sql`select app.release_workflow_run_active_admission(${workspaceId},${delivery.outboxEventId})`,
    )
    .catch(rethrowQueryFailure);
}

/** Re-queues a delivery whose receipt the caller has claimed. */
export async function deferCoordinatorForActiveCapacity(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    revision: number;
    entitlementVersion: number;
    delivery: CoordinatorAdvanceDelivery;
    traceparent?: string;
  }>,
): Promise<RunAdvanceResult | undefined> {
  const capacity = await drizzle(client)
    .execute<{ available: boolean }>(
      sql`select app.workflow_run_active_capacity_available(${input.workspaceId},${input.entitlementVersion},${input.runId}) as available`,
    )
    .catch(rethrowQueryFailure);
  const row = capacity.rows[0];
  if (row === undefined) throw new CoordinatorRunStateCorruptError();
  if (row.available) return undefined;

  const outboxEventId = generatePersistedId();
  const payload = {
    workspaceId: input.workspaceId,
    outboxEventId,
    runId: input.runId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  } as const;
  await drizzle(client)
    .insert(outboxEvents)
    .values({
      id: outboxEventId,
      workspaceId: input.workspaceId,
      jobName: 'advance-workflow-run',
      aggregateType: 'workflow-run',
      aggregateId: input.runId,
      payload: sql`${serializeStoredExecutionJsonValue(payload)}::jsonb`,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
      availableAt: sql`clock_timestamp()+interval '5 seconds'`,
    })
    .catch(rethrowQueryFailure);
  // Preserve the committed slot across FIFO deferral. Completing the old
  // receipt may release only its old binding, never the replacement delivery.
  await drizzle(client)
    .execute(
      sql`select app.rebind_workflow_run_active_admission(${input.workspaceId},${input.runId},${input.delivery.outboxEventId},${outboxEventId})`,
    )
    .catch(rethrowQueryFailure);
  await completeCoordinatorReceipt(client, input.workspaceId, input.delivery);
  return Object.freeze({ kind: 'deferred', revision: input.revision });
}

export async function auditCoordinatorDeliveryMismatch(
  pool: Pool,
  workspaceId: string,
  delivery: CoordinatorAdvanceDelivery,
  signal: AbortSignal,
): Promise<never> {
  await withCoordinatorWriteClient(
    pool,
    workspaceId,
    signal,
    async (client) => {
      await drizzle(client)
        .insert(transportSecurityAuditFacts)
        .values({
          id: generatePersistedId(),
          workspaceId,
          factType: 'inbox_checksum_mismatch',
          consumerName: coordinatorConsumerName,
          messageId: delivery.outboxEventId,
        })
        .catch(rethrowQueryFailure);
    },
  );
  throw new CoordinatorDeliveryMismatchError();
}
