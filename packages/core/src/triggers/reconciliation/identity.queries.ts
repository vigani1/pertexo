import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import {
  canonicalOutboxPayloadChecksum,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import { outboxEvents } from '@pertexo/database/schema';
import type { WorkflowTriggerReconciliationDatabase } from './contract.js';
import { WorkflowTriggerReconciliationMismatchError } from './errors.js';
import { reconciliationPayloadSchema } from './input.js';

type ReconciliationEvent = Readonly<{
  payload: z.output<typeof reconciliationPayloadSchema>;
  payloadChecksum: string;
}>;

export async function readReconciliationEvent(
  client: PoolClient,
  input: Parameters<WorkflowTriggerReconciliationDatabase['reconcile']>[0],
  identity: Readonly<{
    outboxEventId: string;
    versionId: string;
    workflowId: string;
  }>,
): Promise<ReconciliationEvent> {
  const event = await readStoredEvent(
    client,
    input.workspaceId,
    identity.outboxEventId,
  );
  const eventRow = event[0];
  if (eventRow === undefined)
    throw new WorkflowTriggerReconciliationMismatchError(
      'Reconciliation outbox event is unavailable',
    );
  let payload: z.output<typeof reconciliationPayloadSchema>;
  try {
    payload = reconciliationPayloadSchema.parse(eventRow.payload);
  } catch {
    throw new WorkflowTriggerReconciliationMismatchError(
      'Reconciliation outbox payload is invalid',
    );
  }
  assertStoredReconciliationIdentity(input, eventRow, payload, identity);
  return { payload, payloadChecksum: eventRow.payload_checksum };
}

function assertStoredReconciliationIdentity(
  input: Parameters<WorkflowTriggerReconciliationDatabase['reconcile']>[0],
  eventRow: Awaited<ReturnType<typeof readStoredEvent>>[number],
  payload: z.output<typeof reconciliationPayloadSchema>,
  identity: Readonly<{
    outboxEventId: string;
    versionId: string;
    workflowId: string;
  }>,
): void {
  const invalidDelivery =
    eventRow.aggregate_id !== identity.workflowId ||
    eventRow.aggregate_type !== 'workflow' ||
    eventRow.job_name !== 'reconcile-workflow-triggers' ||
    payload.workspaceId !== input.workspaceId ||
    payload.workflowId !== identity.workflowId ||
    payload.publishedVersionId !== identity.versionId ||
    payload.outboxEventId !== identity.outboxEventId ||
    canonicalOutboxPayloadChecksum(payload) !== eventRow.payload_checksum;
  if (invalidDelivery)
    throw new WorkflowTriggerReconciliationMismatchError(
      'Reconciliation durable event identity is inconsistent',
    );
}

export function assertDeliveryIdentity(
  delivery: NonNullable<
    Parameters<
      WorkflowTriggerReconciliationDatabase['reconcile']
    >[0]['delivery']
  >,
  event: ReconciliationEvent,
  outboxEventId: string,
): boolean {
  return (
    delivery.outboxEventId === outboxEventId &&
    delivery.payloadChecksum === event.payloadChecksum
  );
}

function readStoredEvent(
  client: PoolClient,
  workspaceId: string,
  outboxEventId: string,
) {
  return drizzle(client)
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
        eq(outboxEvents.id, outboxEventId),
      ),
    )
    .catch(rethrowQueryFailure);
}
