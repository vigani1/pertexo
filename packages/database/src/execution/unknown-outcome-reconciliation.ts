import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { sha256HexSchema } from '../validation/persisted-primitives.js';

import type { WorkspaceDatabase } from '../database.js';
import { consumeInboxMessage } from './inbox.js';
import { canonicalOutboxPayloadChecksum } from './outbox.js';

const payloadSchema = z
  .object({
    attemptId: z.uuid(),
    evidenceCommandId: z.uuid(),
    outboxEventId: z.uuid(),
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
  })
  .strict();

export class UnknownOutcomeReconciliationMismatchError extends Error {
  public constructor() {
    super(
      'Unknown-outcome reconciliation delivery does not match durable state',
    );
    this.name = 'UnknownOutcomeReconciliationMismatchError';
  }
}

export class UnknownOutcomeReconciliationStateError extends Error {
  public constructor() {
    super('Unknown-outcome reconciliation evidence is no longer actionable');
    this.name = 'UnknownOutcomeReconciliationStateError';
  }
}

export type UnknownOutcomeReconciliationResult = Readonly<{
  kind: 'duplicate' | 'processed';
}>;

export async function reconcileUnknownOutcomeEvidence(
  database: WorkspaceDatabase,
  input: Readonly<{
    attemptId: string;
    delivery: Readonly<{
      outboxEventId: string;
      payloadChecksum: string;
    }>;
    evidenceCommandId: string;
    signal?: AbortSignal;
    workspaceId: string;
  }>,
): Promise<UnknownOutcomeReconciliationResult> {
  const parsed = z
    .object({
      attemptId: z.uuid(),
      delivery: z
        .object({
          outboxEventId: z.uuid(),
          payloadChecksum: sha256HexSchema,
        })
        .strict(),
      evidenceCommandId: z.uuid(),
      signal: z.custom<AbortSignal>().optional(),
      workspaceId: z.uuid(),
    })
    .strict()
    .parse(input);
  parsed.signal?.throwIfAborted();

  const consumed = await consumeInboxMessage(
    database,
    parsed.workspaceId,
    {
      consumerName: 'unknown-outcome-reconciler',
      messageId: parsed.delivery.outboxEventId,
      payloadChecksum: parsed.delivery.payloadChecksum,
    },
    async (transaction) => {
      const outbox = await transaction.db.execute<{
        aggregate_id: string;
        aggregate_type: string;
        job_name: string;
        payload: unknown;
        payload_checksum: string;
        schema_version: number;
      }>(sql`
        select aggregate_id,aggregate_type,job_name,payload,payload_checksum,schema_version
        from app.outbox_events
        where workspace_id=${transaction.workspaceId}
          and id=${parsed.delivery.outboxEventId}
      `);
      const row = outbox.rows[0];
      let payload: z.output<typeof payloadSchema>;
      try {
        payload = payloadSchema.parse(row?.payload);
      } catch {
        throw new UnknownOutcomeReconciliationMismatchError();
      }
      if (row === undefined)
        throw new UnknownOutcomeReconciliationMismatchError();
      if (
        row.aggregate_id !== parsed.attemptId ||
        row.aggregate_type !== 'node-attempt' ||
        row.job_name !== 'reconcile-unknown-outcome' ||
        row.schema_version !== 1 ||
        row.payload_checksum !== parsed.delivery.payloadChecksum ||
        canonicalOutboxPayloadChecksum(payload) !== row.payload_checksum ||
        payload.workspaceId !== transaction.workspaceId ||
        payload.attemptId !== parsed.attemptId ||
        payload.evidenceCommandId !== parsed.evidenceCommandId ||
        payload.outboxEventId !== parsed.delivery.outboxEventId
      )
        throw new UnknownOutcomeReconciliationMismatchError();

      const evidence = await transaction.db.execute<{ status: string }>(sql`
        select attempt.status
        from app.operator_unknown_outcome_evidence evidence
        join app.node_attempts attempt
          on attempt.workspace_id=evidence.workspace_id
          and attempt.id=evidence.attempt_id
        where evidence.workspace_id=${transaction.workspaceId}
          and evidence.command_id=${parsed.evidenceCommandId}
          and evidence.attempt_id=${parsed.attemptId}
      `);
      if (evidence.rows[0]?.status !== 'outcome_unknown')
        throw new UnknownOutcomeReconciliationStateError();
    },
  );
  return Object.freeze({ kind: consumed.status });
}
