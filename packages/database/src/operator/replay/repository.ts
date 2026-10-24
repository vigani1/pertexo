import type { OperatorRunReplayStore } from './contract.js';
import { inputSchema, payloadSchema } from './input.js';
import type { InitialCheckpointFactory } from '../../runs/commands/initial-checkpoint.js';
import { and, eq, sql } from 'drizzle-orm';
import { outboxEvents } from '../../schema/transport.js';
import {
  operatorCommands,
  operatorRunReplayRequests,
} from '../../schema/runs/operator.js';
import { workflowRuns } from '../../schema/runs/execution.js';
import { workflowVersions } from '../../schema/authoring/workflows.js';
import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import {
  createWorkspaceDatabase,
  type WorkspaceDatabase,
} from '../../database.js';
import { acceptWorkflowRun } from '../../runs/commands/acceptance.js';
import { consumeInboxMessage } from '../../outbox/receipts.repository.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import { parsePublishedWorkflowRow } from '../../runs/queries/execution/published.js';
export class OperatorRunReplayMismatchError extends Error {
  public constructor() {
    super('Run replay delivery does not match its durable request');
    this.name = 'OperatorRunReplayMismatchError';
  }
}

export class OperatorRunReplayNotExecutableError extends Error {
  public constructor() {
    super('Run replay target is not executable by this worker');
    this.name = 'OperatorRunReplayNotExecutableError';
  }
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

export function createOperatorRunReplayStore(
  config: DatabaseConfig,
  checkpointFactory: InitialCheckpointFactory,
  runtime?: DatabaseRuntime,
): OperatorRunReplayStore {
  const database = createWorkspaceDatabase(
    config,
    runtime === undefined ? {} : { runtime },
  );
  return Object.freeze({
    replay: (input: z.input<typeof inputSchema>) =>
      replayRequest(input, { database, checkpointFactory }),
    fail: async (input: Parameters<OperatorRunReplayStore['fail']>[0]) => {
      const parsed = z
        .object({
          commandId: z.uuid(),
          safeErrorCode: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
          workspaceId: z.uuid(),
        })
        .strict()
        .parse(input);
      await database.withWorkspace(parsed.workspaceId, async (transaction) => {
        const failed = await transaction.db
          .update(operatorRunReplayRequests)
          .set({
            status: 'failed',
            safeErrorCode: parsed.safeErrorCode,
            completedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(
                operatorRunReplayRequests.workspaceId,
                transaction.workspaceId,
              ),
              eq(operatorRunReplayRequests.commandId, parsed.commandId),
              eq(operatorRunReplayRequests.status, 'pending'),
            ),
          )
          .returning({ commandId: operatorRunReplayRequests.commandId });
        // A request already settled keeps its first outcome.
        if (failed.length === 1)
          await settleCommand(transaction, parsed.commandId, 'failed', {
            outcome: 'replay_failed',
            safeErrorCode: parsed.safeErrorCode,
          });
      });
    },
    close: () => database.close(),
  });
}

type ReplayContext = Readonly<{
  database: WorkspaceDatabase;
  checkpointFactory: InitialCheckpointFactory;
}>;
async function replayRequest(
  input: z.input<typeof inputSchema>,
  context: ReplayContext,
): ReturnType<OperatorRunReplayStore['replay']> {
  const { database, checkpointFactory } = context;
  const parsed = inputSchema.parse(input);
  parsed.signal?.throwIfAborted();
  const consumed = await consumeInboxMessage(database, parsed.workspaceId, {
    message: {
      consumerName: 'operator-run-replay',
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
      const payload = payloadSchema.safeParse(row?.payload);
      const invalidDelivery =
        row === undefined ||
        !payload.success ||
        row.aggregateId !== parsed.commandId ||
        row.aggregateType !== 'operator-command' ||
        row.jobName !== 'replay-workflow-run' ||
        row.payloadChecksum !== parsed.delivery.payloadChecksum ||
        canonicalOutboxPayloadChecksum(payload.data) !== row.payloadChecksum ||
        payload.data.commandId !== parsed.commandId ||
        payload.data.outboxEventId !== parsed.delivery.outboxEventId ||
        payload.data.workspaceId !== transaction.workspaceId;
      if (invalidDelivery) throw new OperatorRunReplayMismatchError();

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
            eq(operatorRunReplayRequests.commandId, parsed.commandId),
          ),
        );
      if (request?.status !== 'pending')
        throw new OperatorRunReplayMismatchError();
      const [storedVersion] = await transaction.db
        .select({
          id: workflowVersions.id,
          workspace_id: workflowVersions.workspaceId,
          workflow_id: workflowVersions.workflowId,
          version_number: workflowVersions.versionNumber,
          checksum: workflowVersions.checksum,
          executable_json: workflowVersions.executableJson,
        })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workspaceId, transaction.workspaceId),
            eq(workflowVersions.id, request.workflowVersionId),
          ),
        );
      const version = parsePublishedWorkflowRow(storedVersion);
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
        replayCommandId: parsed.commandId,
        replaySourceRunId: request.sourceRunId,
        requestHash: request.requestFingerprint,
        runInput: request.runInput,
        scope: `operator:${parsed.commandId}`,
        triggerType: 'replay',
        workflowId: request.workflowId,
        workflowVersionId: request.workflowVersionId,
      });
      const completed = await transaction.db
        .update(operatorRunReplayRequests)
        .set({
          status: 'completed',
          resultRunId: accepted.runId,
          completedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(operatorRunReplayRequests.workspaceId, transaction.workspaceId),
            eq(operatorRunReplayRequests.commandId, parsed.commandId),
            eq(operatorRunReplayRequests.status, 'pending'),
          ),
        )
        .returning({ commandId: operatorRunReplayRequests.commandId });
      if (completed.length !== 1) throw new OperatorRunReplayMismatchError();
      await settleCommand(transaction, parsed.commandId, 'completed', {
        outcome: 'replay_created',
        resultRunId: accepted.runId,
      });
      return accepted.runId;
    },
    options: parsed.signal === undefined ? {} : { signal: parsed.signal },
  });
  return consumed.status === 'duplicate'
    ? Object.freeze({ kind: 'duplicate' as const })
    : Object.freeze({ kind: 'processed' as const, runId: consumed.value });
}
