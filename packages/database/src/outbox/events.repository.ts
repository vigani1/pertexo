import { canonicalJson } from './canonical-json.js';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { outboxEvents } from '../schema.js';
import type { WorkspaceTransaction } from '../tenant-access/transactions.js';

export interface OutboxEventInput {
  id: string;
  jobName: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  payloadChecksum: string;
  availableAt?: Date | undefined;
}

const OUTBOX_PAYLOAD_BYTES = 4096;

export function canonicalOutboxPayloadChecksum(payload: unknown): string {
  return createHash('sha256')
    .update(
      canonicalJson(payload, OUTBOX_PAYLOAD_BYTES, {
        maximumDatabaseBytes: OUTBOX_PAYLOAD_BYTES,
        label: 'outbox payload',
      }),
    )
    .digest('hex');
}

export type InsertedOutboxEvent = Readonly<
  Pick<typeof outboxEvents.$inferSelect, 'id' | 'workspaceId' | 'availableAt'>
>;

export async function insertOutboxEvent(
  transaction: WorkspaceTransaction,
  input: OutboxEventInput,
): Promise<InsertedOutboxEvent> {
  const canonicalPayload = canonicalJson(input.payload, OUTBOX_PAYLOAD_BYTES, {
    maximumDatabaseBytes: OUTBOX_PAYLOAD_BYTES,
    label: 'outbox payload',
  });
  if (
    createHash('sha256').update(canonicalPayload).digest('hex') !==
    input.payloadChecksum
  ) {
    throw new Error(
      'outbox payload checksum does not match its canonical JSON',
    );
  }
  const rows = await transaction.db
    .insert(outboxEvents)
    .values({
      id: input.id,
      workspaceId: transaction.workspaceId,
      jobName: input.jobName,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: sql`${canonicalPayload}::jsonb`,
      payloadChecksum: input.payloadChecksum,
      ...(input.availableAt === undefined
        ? {}
        : { availableAt: input.availableAt }),
    })
    .returning({
      id: outboxEvents.id,
      workspaceId: outboxEvents.workspaceId,
      availableAt: outboxEvents.availableAt,
    });
  const row = rows[0];
  if (row === undefined) {
    throw new Error('Outbox insert returned no row');
  }
  return Object.freeze(row);
}
