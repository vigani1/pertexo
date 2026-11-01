import {
  appendAuditFact,
  checkDatabaseReadiness,
  serializeBoundedPlainJson,
} from '@pertexo/database/primitives';
import {
  acquireDatabasePool,
  generatePersistedId,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { operatorCommands } from '@pertexo/database/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { readStuckWork } from '../runs/stalled/overdue.queries.js';
import { commandRecord } from './command-record.js';
import type {
  GetOperatorCommandInput,
  OperatorCommandOutcome,
  OperatorCommandResult,
  OperatorCommandStoreOptions,
  OperatorRunCommandInput,
  OperatorWorkflowCommandInput,
  ReconcileOperatorAttemptInput,
  RecordUnknownOutcomeEvidenceInput,
  RedispatchFailedOutboxInput,
  ReplayOperatorRunInput,
} from './contract.js';
import { REPLAY_INPUT_BYTES } from './fingerprint.js';
import {
  reconcileAttempt,
  recordUnknownOutcomeEvidence,
} from './handlers/attempts.repository.js';
import { redispatchFailedOutbox } from './handlers/outbox.repository.js';
import { cancelRun, resumeDueWork } from './handlers/runs.repository.js';
import {
  requestRunReplay,
  retryTriggerReconciliation,
} from './handlers/workflows.repository.js';
import {
  runOperatorCommand,
  withOperatorTransaction,
  type OperatorTransactionContext,
} from './run-command.js';

const EVIDENCE_REF_BYTES = 4096;

// These constructor options have no upstream configuration parser.
const optionsSchema = z.object({
  lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
  statementTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
});

export type OperatorCommandStore = ReturnType<
  typeof createOperatorCommandStore
>;

export function createOperatorCommandStore(
  config: DatabaseConfig,
  inputOptions: OperatorCommandStoreOptions = {},
  runtime?: DatabaseRuntime,
) {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;
  const context = { pool, options };

  return Object.freeze({
    checkReadiness: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
    },
    close: () => lease.close(),
    /** Reads across workspaces: an operator doesn't yet know which one is stuck. */
    listStuckWork: () => readStuckWork(drizzle(pool)),
    getCommand: (input: GetOperatorCommandInput) => readCommand(context, input),
    redispatchFailedOutbox: (input: RedispatchFailedOutboxInput) =>
      redispatch(context, input),
    reconcileAttempt: (input: ReconcileOperatorAttemptInput) =>
      runOperatorCommand(context, {
        ...input,
        commandType: 'attempt.reconcile',
        material: {
          action: input.action,
          expectedFence: input.expectedFenceToken,
          targetId: input.attemptId,
        },
        target: { type: 'operator-command-target', id: input.attemptId },
        decide: (transaction) => reconcileAttempt(transaction, input),
      }),
    resumeDueWork: (input: OperatorRunCommandInput) =>
      runOperatorCommand(context, {
        ...input,
        commandType: 'due-work.resume',
        material: { targetId: input.runId },
        target: { type: 'operator-command-target', id: input.runId },
        decide: (transaction) => resumeDueWork(transaction, input),
      }),
    cancelRun: (input: OperatorRunCommandInput) =>
      runOperatorCommand(context, {
        ...input,
        commandType: 'run.cancel',
        material: { targetId: input.runId },
        target: { type: 'operator-command-target', id: input.runId },
        decide: (transaction) => cancelRun(transaction, input),
      }),
    recordUnknownOutcomeEvidence: (input: RecordUnknownOutcomeEvidenceInput) =>
      recordEvidence(context, input),
    retryTriggerReconciliation: (input: OperatorWorkflowCommandInput) =>
      runOperatorCommand(context, {
        ...input,
        commandType: 'trigger.reconcile',
        material: { workflowId: input.workflowId },
        target: { type: 'workflow', id: input.workflowId },
        decide: (transaction) => retryTriggerReconciliation(transaction, input),
      }),
    replayRun: (input: ReplayOperatorRunInput) => replay(context, input),
  });
}

function readCommand(
  context: OperatorTransactionContext,
  input: GetOperatorCommandInput,
) {
  return withOperatorTransaction(
    context,
    input.workspaceId,
    input.signal,
    async (tx) => {
      const [row] = await tx.db
        .select()
        .from(operatorCommands)
        .where(
          and(
            eq(operatorCommands.workspaceId, tx.workspaceId),
            eq(operatorCommands.id, input.commandId),
          ),
        );
      await appendAuditFact(tx, {
        workspaceId: tx.workspaceId,
        action: 'operator.command_status',
        targetType: 'operator-command',
        targetId: input.commandId,
        requestId: generatePersistedId(),
        metadata: {
          actorRef: input.actorRef,
          found: row !== undefined,
          reason: input.reason,
        },
      });
      return row === undefined ? null : commandRecord(row);
    },
  );
}

async function redispatch(
  context: OperatorTransactionContext,
  input: RedispatchFailedOutboxInput,
): Promise<OperatorCommandResult> {
  const result = await runOperatorCommand(context, {
    ...input,
    commandType: 'outbox.redispatch',
    material: { outboxEventId: input.outboxEventId },
    target: { type: 'outbox-event', id: input.outboxEventId },
    decide: (transaction) => redispatchFailedOutbox(transaction, input),
  });
  return Object.freeze({
    commandId: result.commandId,
    outcome: result.outcome as OperatorCommandOutcome,
    replayed: result.replayed,
    status: result.status,
  });
}

function recordEvidence(
  context: OperatorTransactionContext,
  input: RecordUnknownOutcomeEvidenceInput,
) {
  const evidenceRef = serializeBoundedPlainJson(
    input.evidenceRef,
    EVIDENCE_REF_BYTES,
    'Unknown outcome evidence',
  );
  return runOperatorCommand(context, {
    ...input,
    dryRun: false,
    commandType: 'unknown-outcome.record-evidence',
    material: {
      evidenceKind: input.evidenceKind,
      evidenceRef: JSON.parse(evidenceRef),
      targetId: input.attemptId,
    },
    target: { type: 'operator-command-target', id: input.attemptId },
    decide: (transaction) =>
      recordUnknownOutcomeEvidence(transaction, { ...input, evidenceRef }),
  });
}

function replay(
  context: OperatorTransactionContext,
  input: ReplayOperatorRunInput,
) {
  const runInput = serializeBoundedPlainJson(
    input.runInput,
    REPLAY_INPUT_BYTES,
    'Operator replay input',
  );
  return runOperatorCommand(context, {
    ...input,
    commandType: 'run.replay',
    material: {
      runInput: JSON.parse(runInput),
      sourceRunId: input.sourceRunId,
      workflowVersionId: input.workflowVersionId,
    },
    target: { type: 'workflow-run', id: input.sourceRunId },
    auditMetadata: { workflowVersionId: input.workflowVersionId },
    decide: (transaction, fingerprint) =>
      requestRunReplay(transaction, {
        ...input,
        runInput,
        requestFingerprint: fingerprint,
      }),
  });
}
