import { createHash } from 'node:crypto';

import { z } from 'zod';

import { outboxEvents } from '../schema.js';
import type { WorkspaceTransaction } from '../tenant-access/workspace.js';

const checksumSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const boundedJsonSchema = z
  .json()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 4096,
    'outbox payload must not exceed 4096 UTF-8 bytes',
  );
const outboxEventInputSchema = z
  .object({
    id: z.uuid(),
    jobName: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/u),
    schemaVersion: z.number().int().positive().max(32_767),
    aggregateType: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/u),
    aggregateId: z.uuid(),
    payload: boundedJsonSchema,
    payloadChecksum: checksumSchema,
    availableAt: z.date().optional(),
  })
  .strict();

type JsonPrimitive = null | boolean | number | string;
interface JsonObject {
  readonly [key: string]: JsonValue;
}
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

export function canonicalOutboxPayloadChecksum(payload: unknown): string {
  const parsed: JsonValue = z.json().parse(payload);
  return createHash('sha256').update(canonicalJson(parsed)).digest('hex');
}

export type OutboxEventInput = Readonly<z.input<typeof outboxEventInputSchema>>;
export type InsertedOutboxEvent = Readonly<{
  id: string;
  workspaceId: string;
  availableAt: Date;
}>;

export async function insertOutboxEvent(
  transaction: WorkspaceTransaction,
  input: OutboxEventInput,
): Promise<InsertedOutboxEvent> {
  const parsed = outboxEventInputSchema.parse(input);
  if (
    canonicalOutboxPayloadChecksum(parsed.payload) !== parsed.payloadChecksum
  ) {
    throw new Error(
      'outbox payload checksum does not match its canonical JSON',
    );
  }
  const rows = await transaction.db
    .insert(outboxEvents)
    .values({
      id: parsed.id,
      workspaceId: transaction.workspaceId,
      jobName: parsed.jobName,
      schemaVersion: parsed.schemaVersion,
      aggregateType: parsed.aggregateType,
      aggregateId: parsed.aggregateId,
      payload: parsed.payload,
      payloadChecksum: parsed.payloadChecksum,
      ...(parsed.availableAt === undefined
        ? {}
        : { availableAt: parsed.availableAt }),
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

export { checksumSchema as outboxChecksumSchema };
