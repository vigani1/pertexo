import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';

import {
  DeliveryMismatch,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptStateCorruptError,
  attemptJobPayloadSchema,
  type claimDeliverySchema,
  type NodeAttemptDelivery,
} from './node-attempt-run-store-contract.js';
import { withWorkspaceWriteClient } from './node-attempt-run-store-transactions.js';
import { serializeStoredExecutionJsonValue } from './stored-execution-value.js';

export const nodeAttemptConsumerName = 'node-attempt-worker';

export async function validateDelivery(
  client: PoolClient,
  input: z.output<typeof claimDeliverySchema>,
): Promise<void> {
  const result = await client.query<{
    aggregate_id: string;
    aggregate_type: string;
    job_name: string;
    payload: unknown;
    payload_checksum: string;
    schema_version: number;
  }>(
    `select aggregate_id,aggregate_type,job_name,payload,
            payload_checksum,schema_version
     from app.outbox_events
     where workspace_id=$1 and id=$2`,
    [input.workspaceId, input.delivery.outboxEventId],
  );
  const row = result.rows[0];
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
  if (
    row?.aggregate_id !== input.attemptId ||
    row.aggregate_type !== 'node-attempt' ||
    row.job_name !== 'execute-node-attempt' ||
    row.schema_version !== 1 ||
    row.payload_checksum !== input.delivery.payloadChecksum ||
    checksum !== row.payload_checksum ||
    payload.workspaceId !== input.workspaceId ||
    payload.runId !== input.runId ||
    payload.nodeRunId !== input.nodeRunId ||
    payload.attemptId !== input.attemptId ||
    payload.outboxEventId !== input.delivery.outboxEventId
  )
    throw new DeliveryMismatch();
}

export async function claimReceipt(
  client: PoolClient,
  workspaceId: string,
  delivery: NodeAttemptDelivery,
): Promise<'new' | 'incomplete' | 'completed'> {
  const inserted = await client.query(
    `insert into app.inbox_receipts (
       consumer_name,message_id,workspace_id,payload_checksum
     ) values ($1,$2,$3,$4)
     on conflict (consumer_name,message_id) do nothing
     returning message_id`,
    [
      nodeAttemptConsumerName,
      delivery.outboxEventId,
      workspaceId,
      delivery.payloadChecksum,
    ],
  );
  if (inserted.rowCount === 1) return 'new';
  const existing = await client.query<{
    completed_at: Date | null;
    payload_checksum: string;
  }>(
    `select completed_at,payload_checksum
     from app.inbox_receipts
     where consumer_name=$1 and message_id=$2 and workspace_id=$3
     for update`,
    [nodeAttemptConsumerName, delivery.outboxEventId, workspaceId],
  );
  const receipt = existing.rows[0];
  if (receipt === undefined) throw new NodeAttemptStateCorruptError();
  if (receipt.payload_checksum !== delivery.payloadChecksum)
    throw new DeliveryMismatch();
  return receipt.completed_at === null ? 'incomplete' : 'completed';
}

export async function completeReceipt(
  client: PoolClient,
  workspaceId: string,
  delivery: NodeAttemptDelivery,
): Promise<void> {
  const result = await client.query(
    `update app.inbox_receipts set completed_at=clock_timestamp()
     where consumer_name=$1 and message_id=$2 and workspace_id=$3
       and payload_checksum=$4 and completed_at is null`,
    [
      nodeAttemptConsumerName,
      delivery.outboxEventId,
      workspaceId,
      delivery.payloadChecksum,
    ],
  );
  if (result.rowCount !== 1) throw new NodeAttemptStateCorruptError();
}

export async function auditMismatch(
  pool: Pool,
  workspaceId: string,
  delivery: NodeAttemptDelivery,
  signal: AbortSignal,
): Promise<never> {
  await withWorkspaceWriteClient(pool, workspaceId, signal, async (client) => {
    await client.query(
      `insert into app.transport_security_audit_facts (
         id,workspace_id,fact_type,consumer_name,message_id
       ) values ($1,$2,'inbox_checksum_mismatch',$3,$4)`,
      [
        randomUUID(),
        workspaceId,
        nodeAttemptConsumerName,
        delivery.outboxEventId,
      ],
    );
  });
  throw new NodeAttemptDeliveryMismatchError();
}
