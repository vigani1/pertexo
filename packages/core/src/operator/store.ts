import type { AuditMetadata } from '@pertexo/database/primitives';
import {
  appendAuditFact,
  serializeBoundedPlainJson,
  checkDatabaseReadiness,
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import type { Pool } from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  generatePersistedId,
} from '@pertexo/database/platform';
import { readStuckWork } from '../runs/stalled/overdue.queries.js';
import { operatorCommands } from '@pertexo/database/schema';
import { cancelRun, resumeDueWork } from './handlers/runs.repository.js';
import {
  reconcileAttempt,
  recordUnknownOutcomeEvidence,
} from './handlers/attempts.repository.js';
import { redispatchFailedOutbox } from './handlers/outbox.repository.js';
import {
  requestRunReplay,
  retryTriggerReconciliation,
} from './handlers/workflows.repository.js';
import { OperatorCommandConflictError, optionsSchema } from './input.js';
import type {
  OperatorCommandStoreOptions,
  RedispatchFailedOutboxInput,
  ReconcileOperatorAttemptInput,
  OperatorRunCommandInput,
  OperatorWorkflowCommandInput,
  ReplayOperatorRunInput,
  RecordUnknownOutcomeEvidenceInput,
  GetOperatorCommandInput,
  GenericOperatorCommandResult,
  OperatorCommandOutcome,
  OperatorCommandStore,
  CommandRequest,
} from './contract.js';
import { commandRecord } from './command-record.js';
import { requestFingerprint } from './fingerprint.js';
/** Seed of the advisory lock that serializes requests reusing one command id. */
const COMMAND_LOCK_SEED = 7_166_118_813;

export function createOperatorCommandStore(
  config: DatabaseConfig,
  inputOptions: OperatorCommandStoreOptions = {},
  runtime?: DatabaseRuntime,
): OperatorCommandStore {
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
    listStuckWork: () => readStuckWork(drizzle(pool)),
    getCommand: (input: GetOperatorCommandInput) =>
      readOperatorCommand(context, input),
    redispatchFailedOutbox: (input: RedispatchFailedOutboxInput) =>
      redispatchOperatorOutbox(context, input),
    reconcileAttempt: (input: ReconcileOperatorAttemptInput) =>
      reconcileOperatorAttempt(context, input),
    resumeDueWork: (input: OperatorRunCommandInput) =>
      resumeOperatorRun(context, input),
    cancelRun: (input: OperatorRunCommandInput) =>
      cancelOperatorRun(context, input),
    recordUnknownOutcomeEvidence: (input: RecordUnknownOutcomeEvidenceInput) =>
      recordOperatorOutcomeEvidence(context, input),
    retryTriggerReconciliation: (input: OperatorWorkflowCommandInput) =>
      retryOperatorTriggerReconciliation(context, input),
    replayRun: (input: ReplayOperatorRunInput) =>
      replayOperatorRun(context, input),
  });
}

type OperatorTransactionContext = Readonly<{
  pool: Pool;
  options: Required<OperatorCommandStoreOptions>;
}>;

function withOperatorTransaction<T>(
  { pool, options }: OperatorTransactionContext,
  workspaceId: string,
  signal: AbortSignal | undefined,
  work: (transaction: WorkspaceTransaction) => Promise<T>,
): Promise<T> {
  return withWorkspaceTransaction(
    pool,
    workspaceId,
    async (transaction) => {
      await transaction.db.execute(
        sql`select set_config('lock_timeout', ${String(options.lockTimeoutMs)}, true)`,
      );
      return work(transaction);
    },
    {
      statementTimeoutMillis: options.statementTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    },
  );
}
function appendOperatorAudit(
  transaction: WorkspaceTransaction,
  request: CommandRequest,
  metadata: AuditMetadata,
): Promise<unknown> {
  return appendAuditFact(transaction, {
    workspaceId: transaction.workspaceId,
    action: `operator.${request.commandType.replaceAll('.', '_')}`,
    targetType: request.target.type,
    targetId: request.target.id,
    requestId: request.commandId,
    metadata: {
      ...request.auditMetadata,
      ...metadata,
      actorRef: request.actorRef,
      dryRun: request.dryRun,
      reason: request.reason,
    },
  });
}
/**
 * Runs one command in one transaction: a request that reuses a command id
 * replays the stored outcome when it is the same request and conflicts
 * otherwise; a new request decides, applies and records its outcome.
 */
async function runOperatorCommand(
  context: OperatorTransactionContext,
  request: CommandRequest,
): Promise<GenericOperatorCommandResult> {
  const fingerprint = requestFingerprint(request);
  const outcome = await withOperatorTransaction(
    context,
    request.workspaceId,
    request.signal,
    async (transaction): Promise<GenericOperatorCommandResult | 'conflict'> => {
      await transaction.db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${request.commandId}, ${COMMAND_LOCK_SEED}))`,
      );
      const [existing] = await transaction.db
        .select({
          outcome: operatorCommands.outcome,
          requestFingerprint: operatorCommands.requestFingerprint,
          result: operatorCommands.result,
          status: operatorCommands.status,
        })
        .from(operatorCommands)
        .where(eq(operatorCommands.id, request.commandId));
      if (existing !== undefined) {
        const same = existing.requestFingerprint === fingerprint;
        await appendOperatorAudit(transaction, request, {
          outcome: same ? existing.outcome : 'conflict',
          replayed: true,
          requestFingerprint: fingerprint,
        });
        if (!same) return 'conflict';
        return Object.freeze({
          commandId: request.commandId,
          outcome: existing.outcome,
          replayed: true,
          result: Object.freeze(existing.result),
          status: existing.status,
        });
      }

      const decision = await request.decide(transaction, fingerprint);
      const status = (decision.pending ?? false) ? 'pending' : 'completed';
      await transaction.db.insert(operatorCommands).values({
        id: request.commandId,
        workspaceId: transaction.workspaceId,
        commandType: request.commandType,
        dryRun: request.dryRun,
        requestFingerprint: fingerprint,
        status,
        outcome: decision.outcome,
        result: decision.result,
        completedAt: status === 'pending' ? null : sql`clock_timestamp()`,
      });
      await appendOperatorAudit(transaction, request, {
        ...decision.auditMetadata,
        outcome: decision.outcome,
        requestFingerprint: fingerprint,
      });
      return Object.freeze({
        commandId: request.commandId,
        outcome: decision.outcome,
        replayed: false,
        result: Object.freeze(decision.result),
        status,
      });
    },
  );
  // The conflicting attempt is audited before it is refused.
  if (outcome === 'conflict') throw new OperatorCommandConflictError();
  return outcome;
}
async function readOperatorCommand(
  context: OperatorTransactionContext,
  input: Parameters<OperatorCommandStore['getCommand']>[0],
): ReturnType<OperatorCommandStore['getCommand']> {
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

async function redispatchOperatorOutbox(
  context: OperatorTransactionContext,
  input: Parameters<OperatorCommandStore['redispatchFailedOutbox']>[0],
): ReturnType<OperatorCommandStore['redispatchFailedOutbox']> {
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

async function reconcileOperatorAttempt(
  context: OperatorTransactionContext,
  input: Parameters<OperatorCommandStore['reconcileAttempt']>[0],
): ReturnType<OperatorCommandStore['reconcileAttempt']> {
  return runOperatorCommand(context, {
    ...input,
    commandType: 'attempt.reconcile',
    material: {
      action: input.action,
      expectedFence: input.expectedFenceToken,
      targetId: input.attemptId,
    },
    target: { type: 'operator-command-target', id: input.attemptId },
    decide: (transaction) => reconcileAttempt(transaction, input),
  });
}

async function resumeOperatorRun(
  context: OperatorTransactionContext,
  input: Parameters<OperatorCommandStore['resumeDueWork']>[0],
): ReturnType<OperatorCommandStore['resumeDueWork']> {
  return runOperatorCommand(context, {
    ...input,
    commandType: 'due-work.resume',
    material: { targetId: input.runId },
    target: { type: 'operator-command-target', id: input.runId },
    decide: (transaction) => resumeDueWork(transaction, input),
  });
}

async function cancelOperatorRun(
  context: OperatorTransactionContext,
  input: Parameters<OperatorCommandStore['cancelRun']>[0],
): ReturnType<OperatorCommandStore['cancelRun']> {
  return runOperatorCommand(context, {
    ...input,
    commandType: 'run.cancel',
    material: { targetId: input.runId },
    target: { type: 'operator-command-target', id: input.runId },
    decide: (transaction) => cancelRun(transaction, input),
  });
}

async function recordOperatorOutcomeEvidence(
  context: OperatorTransactionContext,
  input: Parameters<OperatorCommandStore['recordUnknownOutcomeEvidence']>[0],
): ReturnType<OperatorCommandStore['recordUnknownOutcomeEvidence']> {
  const evidenceRef = serializeBoundedPlainJson(
    input.evidenceRef,
    4096,
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

async function retryOperatorTriggerReconciliation(
  context: OperatorTransactionContext,
  input: Parameters<OperatorCommandStore['retryTriggerReconciliation']>[0],
): ReturnType<OperatorCommandStore['retryTriggerReconciliation']> {
  return runOperatorCommand(context, {
    ...input,
    commandType: 'trigger.reconcile',
    material: { workflowId: input.workflowId },
    target: { type: 'workflow', id: input.workflowId },
    decide: (transaction) => retryTriggerReconciliation(transaction, input),
  });
}

async function replayOperatorRun(
  context: OperatorTransactionContext,
  input: Parameters<OperatorCommandStore['replayRun']>[0],
): ReturnType<OperatorCommandStore['replayRun']> {
  const runInput = serializeBoundedPlainJson(
    input.runInput,
    65_536,
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
