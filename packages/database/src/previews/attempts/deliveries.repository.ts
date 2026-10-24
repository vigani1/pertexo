import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  outboxEvents,
  inboxReceipts,
  transportSecurityAuditFacts,
} from '../../schema/transport.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';

import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import {
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
  previewDeliveryPayloadSchema,
  previewReconciliationPayloadSchema,
  type PreviewDelivery,
} from '../contract.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';

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
          workspaceId: input.workspaceId,
          outboxEventId,
          previewRunId: input.previewRunId,
          previewAttemptId: input.previewAttemptId,
          ...(input.traceparent === undefined
            ? {}
            : { traceparent: input.traceparent }),
        })
      : previewReconciliationPayloadSchema.parse({
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
  const inserted = await drizzle(client)
    .insert(outboxEvents)
    .values({
      id: outboxEventId,
      workspaceId: input.workspaceId,
      jobName: input.jobName,
      aggregateType: 'preview-run',
      aggregateId: input.previewRunId,
      payload: sql`${JSON.stringify(payload)}::jsonb`,
      payloadChecksum,
      availableAt: sql`coalesce(${input.availableAt ?? null}::timestamptz,clock_timestamp())`,
    })
    .returning({ id: outboxEvents.id })
    .catch(rethrowQueryFailure);
  if (inserted.length !== 1)
    throw new PreviewAttemptStateError('reconciliation_schedule_lost');
  return Object.freeze({ outboxEventId, payloadChecksum });
}

async function readDelivery(
  client: PreviewOutboxClient,
  workspaceId: string,
  outboxEventId: string,
) {
  const rows = await drizzle(client)
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
        eq(outboxEvents.workspaceId, workspaceId),
        eq(outboxEvents.id, outboxEventId),
      ),
    )
    .catch(rethrowQueryFailure);
  return rows[0];
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
  const row = await readDelivery(
    client,
    input.workspaceId,
    input.delivery.outboxEventId,
  );
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
  const invalidExecutionDelivery =
    row.aggregateId !== input.previewRunId ||
    row.aggregateType !== 'preview-run' ||
    row.jobName !== 'execute-preview-attempt' ||
    row.payloadChecksum !== input.delivery.payloadChecksum ||
    checksum !== row.payloadChecksum ||
    payload.workspaceId !== input.workspaceId ||
    payload.previewRunId !== input.previewRunId ||
    payload.previewAttemptId !== input.previewAttemptId ||
    payload.outboxEventId !== input.delivery.outboxEventId;
  if (invalidExecutionDelivery) throw new PreviewDeliveryMismatchError();
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
  const row = await readDelivery(
    client,
    input.workspaceId,
    input.delivery.outboxEventId,
  );
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
  const invalidReconciliationDelivery =
    row.aggregateId !== input.previewRunId ||
    row.aggregateType !== 'preview-run' ||
    row.jobName !== 'reconcile-preview-attempt' ||
    row.payloadChecksum !== input.delivery.payloadChecksum ||
    checksum !== row.payloadChecksum ||
    payload.workspaceId !== input.workspaceId ||
    payload.previewRunId !== input.previewRunId ||
    payload.previewAttemptId !== input.previewAttemptId ||
    payload.attemptFenceToken !== input.attemptFenceToken ||
    payload.outboxEventId !== input.delivery.outboxEventId;
  if (invalidReconciliationDelivery) throw new PreviewDeliveryMismatchError();
  return payload;
}

export async function completePreviewReceipt(
  client: PreviewOutboxClient,
  consumerName: string,
  workspaceId: string,
  delivery: PreviewDelivery,
): Promise<void> {
  const result = await drizzle(client)
    .update(inboxReceipts)
    .set({ completedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(inboxReceipts.consumerName, consumerName),
        eq(inboxReceipts.messageId, delivery.outboxEventId),
        eq(inboxReceipts.workspaceId, workspaceId),
        eq(inboxReceipts.payloadChecksum, delivery.payloadChecksum),
        isNull(inboxReceipts.completedAt),
      ),
    )
    .returning({ messageId: inboxReceipts.messageId })
    .catch(rethrowQueryFailure);
  if (result.length !== 1)
    throw new PreviewAttemptStateError('receipt_completion_lost');
}

async function loadPreviewReceipt(
  client: PreviewOutboxClient,
  consumerName: string,
  workspaceId: string,
  delivery: PreviewDelivery,
): Promise<'completed' | 'open'> {
  const existing = await drizzle(client)
    .select({
      workspaceId: inboxReceipts.workspaceId,
      payloadChecksum: inboxReceipts.payloadChecksum,
      completedAt: inboxReceipts.completedAt,
    })
    .from(inboxReceipts)
    .where(
      and(
        eq(inboxReceipts.consumerName, consumerName),
        eq(inboxReceipts.messageId, delivery.outboxEventId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const receipt = existing[0];
  if (receipt === undefined)
    throw new PreviewAttemptStateError('receipt_missing');
  if (
    receipt.workspaceId !== workspaceId ||
    receipt.payloadChecksum !== delivery.payloadChecksum
  )
    throw new PreviewDeliveryMismatchError();
  return receipt.completedAt === null ? 'open' : 'completed';
}

export async function claimPreviewReceipt(
  client: PreviewOutboxClient,
  consumerName: string,
  workspaceId: string,
  delivery: PreviewDelivery,
): Promise<'completed' | 'open'> {
  const inserted = await drizzle(client)
    .insert(inboxReceipts)
    .values({
      consumerName,
      messageId: delivery.outboxEventId,
      workspaceId,
      payloadChecksum: delivery.payloadChecksum,
    })
    .onConflictDoNothing({
      target: [inboxReceipts.consumerName, inboxReceipts.messageId],
    })
    .returning({ messageId: inboxReceipts.messageId })
    .catch(rethrowQueryFailure);
  if (inserted.length === 1) return 'open';
  return loadPreviewReceipt(client, consumerName, workspaceId, delivery);
}

export async function readPreviewReceipt(
  client: PreviewOutboxClient,
  consumerName: string,
  workspaceId: string,
  delivery: PreviewDelivery,
): Promise<'completed' | 'open'> {
  return loadPreviewReceipt(client, consumerName, workspaceId, delivery);
}

export async function auditPreviewDeliveryMismatch(
  pool: Pool,
  consumerName: string,
  {
    workspaceId,
    delivery,
    signal,
  }: Readonly<{
    workspaceId: string;
    delivery: PreviewDelivery;
    signal: AbortSignal;
  }>,
): Promise<never> {
  await withTenantScopedClient(
    pool,
    { workspaceId },
    async (client) => {
      await drizzle(client)
        .insert(transportSecurityAuditFacts)
        .values({
          id: uuidv7(),
          workspaceId,
          factType: 'inbox_checksum_mismatch',
          consumerName,
          messageId: delivery.outboxEventId,
        })
        .catch(rethrowQueryFailure);
    },
    { signal },
  );
  throw new PreviewDeliveryMismatchError();
}
