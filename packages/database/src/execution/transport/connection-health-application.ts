import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { WorkspaceDatabase } from '../../database.js';
import { sha256HexSchema } from '../../validation/persisted-primitives.js';
import { consumeInboxMessage, InboxReceiptUnavailableError } from './inbox.js';
import { canonicalOutboxPayloadChecksum } from './outbox.js';

const payloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
    outboxEventId: z.uuid(),
    observationId: z.uuid(),
    traceparent: z
      .string()
      .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
      .optional(),
  })
  .strict();
const inputSchema = z
  .object({
    workspaceId: z.uuid(),
    observationId: z.uuid(),
    mode: z.enum(['off', 'observe', 'enforce']),
    delivery: z
      .object({ outboxEventId: z.uuid(), payloadChecksum: sha256HexSchema })
      .strict(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();

export type ConnectionHealthApplicationResult = Readonly<{
  kind: 'applied' | 'stale' | 'duplicate';
}>;

/** Consumes persisted IDs, never a caller-chosen connection/status/reason. */
export async function applyConnectionHealthObservation(
  database: WorkspaceDatabase,
  input: Readonly<z.input<typeof inputSchema>>,
): Promise<ConnectionHealthApplicationResult> {
  const parsed = inputSchema.parse(input);
  parsed.signal?.throwIfAborted();
  const consumed = await consumeInboxMessage(
    database,
    parsed.workspaceId,
    {
      consumerName: 'connection-health-worker',
      messageId: parsed.delivery.outboxEventId,
      payloadChecksum: parsed.delivery.payloadChecksum,
    },
    async (transaction) => {
      const outbox = await transaction.db.execute<{
        aggregate_id: string;
        aggregate_type: string;
        job_name: string;
        schema_version: number;
        payload: unknown;
        payload_checksum: string;
      }>(sql`
      select aggregate_id,aggregate_type,job_name,schema_version,payload,payload_checksum from app.outbox_events
      where workspace_id=${transaction.workspaceId} and id=${parsed.delivery.outboxEventId}`);
      const row = outbox.rows[0];
      if (row === undefined) {
        const remaining = await transaction.db
          .execute(sql`select id from app.connection_health_observations
        where workspace_id=${transaction.workspaceId} and id=${parsed.observationId}`);
        if (remaining.rows.length !== 0)
          throw new InboxReceiptUnavailableError();
        // Retention deletes source evidence and its command together. A delayed
        // delivery cannot resurrect either or modify a connection.
        return false;
      }
      const payload = payloadSchema.safeParse(row.payload);
      if (
        !payload.success ||
        row.aggregate_id !== parsed.observationId ||
        row.aggregate_type !== 'connection-health-observation' ||
        row.job_name !== 'apply-connection-health-observation' ||
        row.schema_version !== 1 ||
        row.payload_checksum !== parsed.delivery.payloadChecksum ||
        canonicalOutboxPayloadChecksum(payload.data) !== row.payload_checksum ||
        payload.data.workspaceId !== transaction.workspaceId ||
        payload.data.outboxEventId !== parsed.delivery.outboxEventId ||
        payload.data.observationId !== parsed.observationId
      )
        throw new InboxReceiptUnavailableError();
      const result = await transaction.db.execute<{
        applied: boolean;
      }>(sql`select app.apply_connection_health_observation(
      ${transaction.workspaceId},${parsed.observationId},${parsed.mode},${parsed.delivery.outboxEventId},${parsed.delivery.payloadChecksum}) applied`);
      return result.rows[0]?.applied === true;
    },
    {
      lockWorkspace: true,
      ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
    },
  );
  return Object.freeze({
    kind:
      consumed.status === 'duplicate'
        ? 'duplicate'
        : consumed.value
          ? 'applied'
          : 'stale',
  });
}
