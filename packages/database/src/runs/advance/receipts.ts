import { createHash } from 'node:crypto';

import { generatePersistedId } from '../../platform/persisted-id.js';

import type { Pool, PoolClient } from 'pg';

import {
  CoordinatorDeliveryMismatchError,
  CoordinatorRunStateCorruptError,
  type CoordinatorAdvanceDelivery,
  type RunAdvanceResult,
} from './contract.js';
import { withCoordinatorWriteClient } from './transactions.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.js';
import { serializeStoredExecutionJsonValue } from '../../platform/stored-execution-value.js';

const coordinatorConsumerName = 'workflow-coordinator';

export class DeliveryMismatch extends Error {}

export async function validateAuthoritativeAdvanceDelivery(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  delivery: CoordinatorAdvanceDelivery,
): Promise<void> {
  const result = await client.query<{
    aggregate_id: string;
    aggregate_type: string;
    job_name: string;
    payload: unknown;
    payload_checksum: string;
  }>(
    `select aggregate_id, aggregate_type, job_name, payload,
            payload_checksum
     from app.outbox_events
     where workspace_id=$1 and id=$2`,
    [workspaceId, delivery.outboxEventId],
  );
  const row = result.rows[0];
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
  if (
    row?.aggregate_id !== runId ||
    row.aggregate_type !== 'workflow-run' ||
    row.job_name !== 'advance-workflow-run' ||
    row.payload_checksum !== delivery.payloadChecksum ||
    storedChecksum !== row.payload_checksum
  )
    throw new DeliveryMismatch();
}

export async function claimCoordinatorReceipt(
  client: PoolClient,
  workspaceId: string,
  delivery: CoordinatorAdvanceDelivery,
): Promise<'new' | 'duplicate'> {
  const inserted = await client.query(
    `insert into app.inbox_receipts (
       consumer_name, message_id, workspace_id, payload_checksum
     ) values ($1,$2,$3,$4)
     on conflict (consumer_name,message_id) do nothing
     returning message_id`,
    [
      coordinatorConsumerName,
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
    `select completed_at, payload_checksum
     from app.inbox_receipts
     where consumer_name=$1 and message_id=$2 and workspace_id=$3
     for update`,
    [coordinatorConsumerName, delivery.outboxEventId, workspaceId],
  );
  const receipt = existing.rows[0];
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
  const completed = await client.query(
    `update app.inbox_receipts
     set completed_at=clock_timestamp()
     where consumer_name=$1 and message_id=$2 and workspace_id=$3
       and payload_checksum=$4 and completed_at is null`,
    [
      coordinatorConsumerName,
      delivery.outboxEventId,
      workspaceId,
      delivery.payloadChecksum,
    ],
  );
  if (completed.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  await client.query(
    `select app.release_workflow_run_active_admission($1,$2)`,
    [workspaceId, delivery.outboxEventId],
  );
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
  const capacity = await client.query<{ available: boolean }>(
    `select app.workflow_run_active_capacity_available($1,$2,$3) as available`,
    [input.workspaceId, input.entitlementVersion, input.runId],
  );
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
  await client.query(
    `insert into app.outbox_events (
       id,workspace_id,job_name,aggregate_type,aggregate_id,
       payload,payload_checksum,available_at
     ) values ($1,$2,'advance-workflow-run','workflow-run',$3,$4::jsonb,$5,
       clock_timestamp() + interval '5 seconds')`,
    [
      outboxEventId,
      input.workspaceId,
      input.runId,
      serializeStoredExecutionJsonValue(payload),
      canonicalOutboxPayloadChecksum(payload),
    ],
  );
  // Preserve the committed slot across FIFO deferral. Completing the old
  // receipt may release only its old binding, never the replacement delivery.
  await client.query(
    `select app.rebind_workflow_run_active_admission($1,$2,$3,$4)`,
    [
      input.workspaceId,
      input.runId,
      input.delivery.outboxEventId,
      outboxEventId,
    ],
  );
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
      await client.query(
        `insert into app.transport_security_audit_facts (
           id,workspace_id,fact_type,consumer_name,message_id
         ) values ($1,$2,'inbox_checksum_mismatch',$3,$4)`,
        [
          generatePersistedId(),
          workspaceId,
          coordinatorConsumerName,
          delivery.outboxEventId,
        ],
      );
    },
  );
  throw new CoordinatorDeliveryMismatchError();
}
