import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';

import { canonicalOutboxPayloadChecksum } from './outbox.js';
import {
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
  previewDeliveryPayloadSchema,
  previewReconciliationPayloadSchema,
  type PreviewDelivery,
} from './preview-execution-contract.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';

export type PreviewOutboxClient = Parameters<
  Parameters<typeof withTenantScopedClient>[2]
>[0];

export async function insertPreviewOutboxDelivery(
  client: PreviewOutboxClient,
  input:
    | Readonly<{
        availableAt?: Date;
        jobName: 'execute-preview-attempt';
        previewAttemptId: string;
        previewRunId: string;
        traceparent?: string;
        workspaceId: string;
      }>
    | Readonly<{
        attemptFenceToken: number;
        availableAt: Date;
        jobName: 'reconcile-preview-attempt';
        previewAttemptId: string;
        previewRunId: string;
        traceparent?: string;
        workspaceId: string;
      }>,
): Promise<Readonly<{ outboxEventId: string; payloadChecksum: string }>> {
  const outboxEventId = uuidv7();
  const payload =
    input.jobName === 'execute-preview-attempt'
      ? previewDeliveryPayloadSchema.parse({
          schemaVersion: 1,
          workspaceId: input.workspaceId,
          outboxEventId,
          previewRunId: input.previewRunId,
          previewAttemptId: input.previewAttemptId,
          ...(input.traceparent === undefined
            ? {}
            : { traceparent: input.traceparent }),
        })
      : previewReconciliationPayloadSchema.parse({
          schemaVersion: 1,
          workspaceId: input.workspaceId,
          outboxEventId,
          previewRunId: input.previewRunId,
          previewAttemptId: input.previewAttemptId,
          attemptFenceToken: input.attemptFenceToken,
          ...(input.traceparent === undefined
            ? {}
            : { traceparent: input.traceparent }),
        });
  const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
  const inserted = await client.query(
    `insert into app.outbox_events (
       id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
       payload,payload_checksum,available_at
     ) values (
       $1,$2,$3,1,'preview-run',$4,$5::jsonb,$6,
       coalesce($7::timestamptz,clock_timestamp())
     )`,
    [
      outboxEventId,
      input.workspaceId,
      input.jobName,
      input.previewRunId,
      JSON.stringify(payload),
      payloadChecksum,
      input.availableAt ?? null,
    ],
  );
  if (inserted.rowCount !== 1)
    throw new PreviewAttemptStateError('reconciliation_schedule_lost');
  return Object.freeze({ outboxEventId, payloadChecksum });
}

export async function validatePreviewDelivery(
  client: Parameters<Parameters<typeof withTenantScopedClient>[2]>[0],
  input: Readonly<{
    delivery: PreviewDelivery;
    previewAttemptId: string;
    previewRunId: string;
    workspaceId: string;
  }>,
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
  if (row === undefined) {
    // Under this workspace scope the aggregate does not exist: forced RLS
    // hides foreign work, so this is a scope violation, not tampering.
    throw new PreviewAttemptStateError('delivery_not_found');
  }
  let payload: z.output<typeof previewDeliveryPayloadSchema> | undefined;
  let checksum: string | undefined;
  try {
    payload = previewDeliveryPayloadSchema.parse(row.payload);
    checksum = canonicalOutboxPayloadChecksum(payload);
  } catch {
    throw new PreviewDeliveryMismatchError();
  }
  if (
    row.aggregate_id !== input.previewRunId ||
    row.aggregate_type !== 'preview-run' ||
    row.job_name !== 'execute-preview-attempt' ||
    row.schema_version !== 1 ||
    row.payload_checksum !== input.delivery.payloadChecksum ||
    checksum !== row.payload_checksum ||
    payload.workspaceId !== input.workspaceId ||
    payload.previewRunId !== input.previewRunId ||
    payload.previewAttemptId !== input.previewAttemptId ||
    payload.outboxEventId !== input.delivery.outboxEventId
  )
    throw new PreviewDeliveryMismatchError();
}

export async function validatePreviewReconciliationDelivery(
  client: PreviewOutboxClient,
  input: Readonly<{
    attemptFenceToken: number;
    delivery: PreviewDelivery;
    previewAttemptId: string;
    previewRunId: string;
    workspaceId: string;
  }>,
): Promise<z.output<typeof previewReconciliationPayloadSchema>> {
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
  if (row === undefined)
    throw new PreviewAttemptStateError('delivery_not_found');
  let payload: z.output<typeof previewReconciliationPayloadSchema>;
  let checksum: string;
  try {
    payload = previewReconciliationPayloadSchema.parse(row.payload);
    checksum = canonicalOutboxPayloadChecksum(payload);
  } catch {
    throw new PreviewDeliveryMismatchError();
  }
  if (
    row.aggregate_id !== input.previewRunId ||
    row.aggregate_type !== 'preview-run' ||
    row.job_name !== 'reconcile-preview-attempt' ||
    row.schema_version !== 1 ||
    row.payload_checksum !== input.delivery.payloadChecksum ||
    checksum !== row.payload_checksum ||
    payload.workspaceId !== input.workspaceId ||
    payload.previewRunId !== input.previewRunId ||
    payload.previewAttemptId !== input.previewAttemptId ||
    payload.attemptFenceToken !== input.attemptFenceToken ||
    payload.outboxEventId !== input.delivery.outboxEventId
  )
    throw new PreviewDeliveryMismatchError();
  return payload;
}

export async function completePreviewReceipt(
  client: PreviewOutboxClient,
  consumerName: string,
  workspaceId: string,
  delivery: PreviewDelivery,
): Promise<void> {
  const result = await client.query(
    `update app.inbox_receipts set completed_at=clock_timestamp()
     where consumer_name=$1 and message_id=$2 and workspace_id=$3
       and payload_checksum=$4 and completed_at is null`,
    [
      consumerName,
      delivery.outboxEventId,
      workspaceId,
      delivery.payloadChecksum,
    ],
  );
  if (result.rowCount !== 1)
    throw new PreviewAttemptStateError('receipt_completion_lost');
}

export async function claimPreviewReceipt(
  client: PreviewOutboxClient,
  consumerName: string,
  workspaceId: string,
  delivery: PreviewDelivery,
): Promise<'completed' | 'open'> {
  const inserted = await client.query(
    `insert into app.inbox_receipts (
       consumer_name,message_id,workspace_id,payload_checksum
     ) values ($1,$2,$3,$4)
     on conflict (consumer_name,message_id) do nothing
     returning message_id`,
    [
      consumerName,
      delivery.outboxEventId,
      workspaceId,
      delivery.payloadChecksum,
    ],
  );
  if (inserted.rowCount === 1) return 'open';
  const existing = await client.query<{
    completed_at: Date | null;
    payload_checksum: string;
    workspace_id: string;
  }>(
    `select workspace_id,payload_checksum,completed_at
     from app.inbox_receipts
     where consumer_name=$1 and message_id=$2
     for update`,
    [consumerName, delivery.outboxEventId],
  );
  const receipt = existing.rows[0];
  if (receipt === undefined)
    throw new PreviewAttemptStateError('receipt_missing');
  if (
    receipt.workspace_id !== workspaceId ||
    receipt.payload_checksum !== delivery.payloadChecksum
  )
    throw new PreviewDeliveryMismatchError();
  return receipt.completed_at === null ? 'open' : 'completed';
}

export async function auditPreviewDeliveryMismatch(
  pool: Pool,
  consumerName: string,
  workspaceId: string,
  delivery: PreviewDelivery,
  signal: AbortSignal,
): Promise<never> {
  await withTenantScopedClient(
    pool,
    { workspaceId },
    async (client) => {
      await client.query(
        `insert into app.transport_security_audit_facts (
           id,workspace_id,fact_type,consumer_name,message_id
         ) values ($1,$2,'inbox_checksum_mismatch',$3,$4)`,
        [uuidv7(), workspaceId, consumerName, delivery.outboxEventId],
      );
    },
    { signal },
  );
  throw new PreviewDeliveryMismatchError();
}
