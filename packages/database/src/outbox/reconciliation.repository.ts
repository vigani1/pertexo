import { and, eq } from 'drizzle-orm';
import { outboxEvents } from '../schema/transport.js';
import { nodeAttempts } from '../schema/runs/execution.js';
import { operatorUnknownOutcomeEvidence } from '../schema/runs/operator.js';
import { z } from 'zod';
import type { WorkspaceDatabase } from '../database.js';
import { consumeInboxMessage } from './receipts.repository.js';
import { canonicalOutboxPayloadChecksum } from './events.repository.js';

const payloadSchema = z
  .object({
    attemptId: z.uuid(),
    evidenceCommandId: z.uuid(),
    outboxEventId: z.uuid(),
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
  const parsed = input;
  parsed.signal?.throwIfAborted();

  const consumed = await consumeInboxMessage(database, parsed.workspaceId, {
    message: {
      consumerName: 'unknown-outcome-reconciler',
      messageId: parsed.delivery.outboxEventId,
      payloadChecksum: parsed.delivery.payloadChecksum,
    },
    operation: async (transaction) => {
      const [row] = await transaction.db
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
            eq(outboxEvents.workspaceId, transaction.workspaceId),
            eq(outboxEvents.id, parsed.delivery.outboxEventId),
          ),
        );
      let payload: z.output<typeof payloadSchema>;
      try {
        payload = payloadSchema.parse(row?.payload);
      } catch {
        throw new UnknownOutcomeReconciliationMismatchError();
      }
      if (row === undefined)
        throw new UnknownOutcomeReconciliationMismatchError();
      const invalidDelivery =
        row.aggregateId !== parsed.attemptId ||
        row.aggregateType !== 'node-attempt' ||
        row.jobName !== 'reconcile-unknown-outcome' ||
        row.payloadChecksum !== parsed.delivery.payloadChecksum ||
        canonicalOutboxPayloadChecksum(payload) !== row.payloadChecksum ||
        payload.workspaceId !== transaction.workspaceId ||
        payload.attemptId !== parsed.attemptId ||
        payload.evidenceCommandId !== parsed.evidenceCommandId ||
        payload.outboxEventId !== parsed.delivery.outboxEventId;
      if (invalidDelivery)
        throw new UnknownOutcomeReconciliationMismatchError();

      const [evidence] = await transaction.db
        .select({ status: nodeAttempts.status })
        .from(operatorUnknownOutcomeEvidence)
        .innerJoin(
          nodeAttempts,
          and(
            eq(
              nodeAttempts.workspaceId,
              operatorUnknownOutcomeEvidence.workspaceId,
            ),
            eq(nodeAttempts.id, operatorUnknownOutcomeEvidence.attemptId),
          ),
        )
        .where(
          and(
            eq(
              operatorUnknownOutcomeEvidence.workspaceId,
              transaction.workspaceId,
            ),
            eq(
              operatorUnknownOutcomeEvidence.commandId,
              parsed.evidenceCommandId,
            ),
            eq(operatorUnknownOutcomeEvidence.attemptId, parsed.attemptId),
          ),
        );
      if (evidence?.status !== 'outcome_unknown')
        throw new UnknownOutcomeReconciliationStateError();
    },
    options: parsed.signal === undefined ? {} : { signal: parsed.signal },
  });
  return Object.freeze({ kind: consumed.status });
}
