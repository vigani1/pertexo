import { and, eq } from 'drizzle-orm';
import {
  outboxEvents,
  nodeAttempts,
  operatorUnknownOutcomeEvidence,
} from '@pertexo/database/schema';
import { z } from 'zod';
import type { WorkspaceDatabase } from '@pertexo/database/platform';
import { consumeInboxMessage } from './receipts.repository.js';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';
import { DELIVERY_CONSUMER } from './delivery-consumers.js';

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
  input.signal?.throwIfAborted();

  const consumed = await consumeInboxMessage(database, input.workspaceId, {
    message: {
      consumerName: DELIVERY_CONSUMER['reconcile-unknown-outcome'],
      messageId: input.delivery.outboxEventId,
      payloadChecksum: input.delivery.payloadChecksum,
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
            eq(outboxEvents.id, input.delivery.outboxEventId),
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
        row.aggregateId !== input.attemptId ||
        row.aggregateType !== 'node-attempt' ||
        row.jobName !== 'reconcile-unknown-outcome' ||
        row.payloadChecksum !== input.delivery.payloadChecksum ||
        canonicalOutboxPayloadChecksum(payload) !== row.payloadChecksum ||
        payload.workspaceId !== transaction.workspaceId ||
        payload.attemptId !== input.attemptId ||
        payload.evidenceCommandId !== input.evidenceCommandId ||
        payload.outboxEventId !== input.delivery.outboxEventId;
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
              input.evidenceCommandId,
            ),
            eq(operatorUnknownOutcomeEvidence.attemptId, input.attemptId),
          ),
        );
      if (evidence?.status !== 'outcome_unknown')
        throw new UnknownOutcomeReconciliationStateError();
    },
    options: input.signal === undefined ? {} : { signal: input.signal },
  });
  return Object.freeze({ kind: consumed.status });
}
