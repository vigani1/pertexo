import {
  canonicalOutboxPayloadChecksum,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import {
  createWorkspaceDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
  type WorkspaceDatabase,
} from '@pertexo/database/platform';
import {
  operatorCommands,
  operatorRunReplayRequests,
  outboxEvents,
  workflowRuns,
} from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { DELIVERY_CONSUMER } from '../../outbox/delivery-consumers.js';
import { consumeInboxMessage } from '../../outbox/receipts.repository.js';
import { acceptWorkflowRun } from '../../runs/commands/acceptance.repository.js';
import type { InitialCheckpointFactory } from '../../runs/commands/initial-checkpoint.js';
import { findPublishedWorkflow } from '../../runs/queries/execution/published.queries.js';
import {
  OperatorRunReplayMismatchError,
  OperatorRunReplayNotExecutableError,
  type FailReplayInput,
  type ReplayDeliveryInput,
} from './contract.js';

const payloadSchema = z
  .object({
    commandId: z.uuid(),
    outboxEventId: z.uuid(),
    workspaceId: z.uuid(),
  })
  .strict();

export type OperatorRunReplayStore = ReturnType<
  typeof createOperatorRunReplayStore
>;

export function createOperatorRunReplayStore(
  config: DatabaseConfig,
  checkpointFactory: InitialCheckpointFactory,
  runtime?: DatabaseRuntime,
) {
  const database = createWorkspaceDatabase(
    config,
    runtime === undefined ? {} : { runtime },
  );
  return Object.freeze({
    replay: (input: ReplayDeliveryInput) =>
      replayRequest(input, { database, checkpointFactory }),
    fail: (input: FailReplayInput) =>
      database.withWorkspace(input.workspaceId, (transaction) =>
        failRequest(transaction, input),
      ),
    close: () => database.close(),
  });
}

type ReplayContext = Readonly<{
  database: WorkspaceDatabase;
  checkpointFactory: InitialCheckpointFactory;
}>;

async function replayRequest(
  input: ReplayDeliveryInput,
  { database, checkpointFactory }: ReplayContext,
) {
  input.signal?.throwIfAborted();
  const consumed = await consumeInboxMessage(database, input.workspaceId, {
    message: {
      consumerName: DELIVERY_CONSUMER['replay-workflow-run'],
      messageId: input.delivery.outboxEventId,
      payloadChecksum: input.delivery.payloadChecksum,
    },
    operation: async (transaction) => {
      await requireMatchingDelivery(transaction, input);
      const request = await readPendingRequest(transaction, input.commandId);
      const version = await findPublishedWorkflow(transaction.db, {
        workspaceId: transaction.workspaceId,
        id: request.workflowVersionId,
      });
      if (version?.workflowId !== request.workflowId)
        throw new OperatorRunReplayNotExecutableError();
      const initial = checkpointFactory(version);
      const accepted = await acceptWorkflowRun(transaction, {
        ...(request.startedBy === null ? {} : { startedBy: request.startedBy }),
        initialCheckpoint: initial.checkpoint,
        ...(initial.validateInput === undefined
          ? {}
          : { validateInput: initial.validateInput }),
        keyHash: request.requestFingerprint,
        operation: 'workflow.run.accept',
        replayCommandId: input.commandId,
        replaySourceRunId: request.sourceRunId,
        requestHash: request.requestFingerprint,
        runInput: request.runInput,
        scope: `operator:${input.commandId}`,
        triggerType: 'replay',
        workflowId: request.workflowId,
        workflowVersionId: request.workflowVersionId,
      });
      await completeRequest(transaction, input.commandId, accepted.runId);
      return accepted.runId;
    },
    options: input.signal === undefined ? {} : { signal: input.signal },
  });
  return consumed.status === 'duplicate'
    ? Object.freeze({ kind: 'duplicate' as const })
    : Object.freeze({ kind: 'processed' as const, runId: consumed.value });
}

/** The queue is only a wakeup: the stored outbox row must back what it delivered. */
async function requireMatchingDelivery(
  transaction: WorkspaceTransaction,
  input: ReplayDeliveryInput,
): Promise<void> {
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
  const payload = payloadSchema.safeParse(row?.payload);
  if (
    row === undefined ||
    !payload.success ||
    row.aggregateId !== input.commandId ||
    row.aggregateType !== 'operator-command' ||
    row.jobName !== 'replay-workflow-run' ||
    row.payloadChecksum !== input.delivery.payloadChecksum ||
    canonicalOutboxPayloadChecksum(payload.data) !== row.payloadChecksum ||
    payload.data.commandId !== input.commandId ||
    payload.data.outboxEventId !== input.delivery.outboxEventId ||
    payload.data.workspaceId !== transaction.workspaceId
  )
    throw new OperatorRunReplayMismatchError();
}

async function readPendingRequest(
  transaction: WorkspaceTransaction,
  commandId: string,
) {
  const [request] = await transaction.db
    .select({
      requestFingerprint: operatorRunReplayRequests.requestFingerprint,
      runInput: operatorRunReplayRequests.runInput,
      sourceRunId: operatorRunReplayRequests.sourceRunId,
      status: operatorRunReplayRequests.status,
      workflowId: operatorRunReplayRequests.workflowId,
      workflowVersionId: operatorRunReplayRequests.workflowVersionId,
      startedBy: workflowRuns.startedBy,
    })
    .from(operatorRunReplayRequests)
    .leftJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, operatorRunReplayRequests.workspaceId),
        eq(workflowRuns.id, operatorRunReplayRequests.sourceRunId),
      ),
    )
    .where(
      and(
        eq(operatorRunReplayRequests.workspaceId, transaction.workspaceId),
        eq(operatorRunReplayRequests.commandId, commandId),
      ),
    );
  if (request?.status !== 'pending') throw new OperatorRunReplayMismatchError();
  return request;
}

async function completeRequest(
  transaction: WorkspaceTransaction,
  commandId: string,
  runId: string,
): Promise<void> {
  const completed = await transaction.db
    .update(operatorRunReplayRequests)
    .set({
      status: 'completed',
      resultRunId: runId,
      completedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(operatorRunReplayRequests.workspaceId, transaction.workspaceId),
        eq(operatorRunReplayRequests.commandId, commandId),
        eq(operatorRunReplayRequests.status, 'pending'),
      ),
    )
    .returning({ commandId: operatorRunReplayRequests.commandId });
  if (completed.length !== 1) throw new OperatorRunReplayMismatchError();
  await settleCommand(transaction, commandId, 'completed', {
    outcome: 'replay_created',
    resultRunId: runId,
  });
}

async function failRequest(
  transaction: WorkspaceTransaction,
  input: FailReplayInput,
): Promise<void> {
  const failed = await transaction.db
    .update(operatorRunReplayRequests)
    .set({
      status: 'failed',
      safeErrorCode: input.safeErrorCode,
      completedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(operatorRunReplayRequests.workspaceId, transaction.workspaceId),
        eq(operatorRunReplayRequests.commandId, input.commandId),
        eq(operatorRunReplayRequests.status, 'pending'),
      ),
    )
    .returning({ commandId: operatorRunReplayRequests.commandId });
  // A request already settled keeps its first outcome.
  if (failed.length === 1)
    await settleCommand(transaction, input.commandId, 'failed', {
      outcome: 'replay_failed',
      safeErrorCode: input.safeErrorCode,
    });
}

/** Settles the pending replay command with the request's outcome. */
async function settleCommand(
  transaction: WorkspaceTransaction,
  commandId: string,
  status: 'completed' | 'failed',
  outcome: Readonly<{ outcome: string } & Record<string, string>>,
): Promise<void> {
  const settled = await transaction.db
    .update(operatorCommands)
    .set({
      status,
      outcome: outcome.outcome,
      completedAt: sql`clock_timestamp()`,
      result: sql`${operatorCommands.result}||${JSON.stringify(outcome)}::jsonb`,
    })
    .where(
      and(
        eq(operatorCommands.workspaceId, transaction.workspaceId),
        eq(operatorCommands.id, commandId),
        eq(operatorCommands.status, 'pending'),
      ),
    )
    .returning({ id: operatorCommands.id });
  if (settled.length !== 1)
    throw new Error('Run replay command is no longer pending');
}
