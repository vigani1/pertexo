import { and, eq, sql } from 'drizzle-orm';

import type { DatabaseConfig } from '../config.js';
import { serializeBoundedPlainJson } from '../outbox/events.js';
import { acquireDatabasePool } from '../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../platform/pool/runtime.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import { checkDatabaseReadiness } from '../platform/readiness.js';
import { auditEvents } from '../schema/foundation.js';
import { operatorCommands } from '../schema/runs/operator.js';
import {
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '../tenant-access/transactions.js';
import {
  cancelRun,
  reconcileAttempt,
  recordUnknownOutcomeEvidence,
  redispatchFailedOutbox,
  requestRunReplay,
  resumeDueWork,
  retryTriggerReconciliation,
} from './command-handlers.js';
import {
  OperatorCommandConflictError,
  redispatchInputSchema,
  reconcileAttemptInputSchema,
  targetRunInputSchema,
  targetWorkflowInputSchema,
  replayRunInputSchema,
  unknownEvidenceInputSchema,
  getCommandInputSchema,
  optionsSchema,
  type OperatorCommandDatabaseOptions,
  type RedispatchFailedOutboxInput,
  type ReconcileOperatorAttemptInput,
  type OperatorRunCommandInput,
  type OperatorWorkflowCommandInput,
  type ReplayOperatorRunInput,
  type RecordUnknownOutcomeEvidenceInput,
  type GetOperatorCommandInput,
  type GenericOperatorCommandResult,
  type OperatorCommandOutcome,
  type OperatorCommandDatabase,
  type CommandRequest,
  statusSchema,
  resultSchema,
} from './contract.js';
import { commandRecord } from './records.js';
import { requestFingerprint } from './fingerprint.js';

export {
  OperatorCommandConflictError,
  type OperatorCommandDatabaseOptions,
  type RedispatchFailedOutboxInput,
  type ReconcileOperatorAttemptInput,
  type OperatorRunCommandInput,
  type OperatorWorkflowCommandInput,
  type ReplayOperatorRunInput,
  type RecordUnknownOutcomeEvidenceInput,
  type GetOperatorCommandInput,
  type GenericOperatorCommandResult,
  type OperatorCommandOutcome,
  type OperatorCommandResult,
  type OperatorCommandRecord,
  type OperatorCommandDatabase,
} from './contract.js';
/** Seed of the advisory lock that serializes requests reusing one command id. */
const COMMAND_LOCK_SEED = 7_166_118_813;

export function createOperatorCommandDatabase(
  config: DatabaseConfig,
  inputOptions: OperatorCommandDatabaseOptions = {},
  runtime?: DatabaseRuntime,
): OperatorCommandDatabase {
  const options = optionsSchema.parse(inputOptions);
  const lease = acquireDatabasePool(config, runtime, { role: 'maintenance' });
  const { pool } = lease;

  const inTransaction = <T>(
    workspaceId: string,
    signal: AbortSignal | undefined,
    work: (transaction: WorkspaceTransaction) => Promise<T>,
  ): Promise<T> =>
    withWorkspaceTransaction(
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

  const audit = (
    transaction: WorkspaceTransaction,
    request: CommandRequest,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<unknown> =>
    transaction.db.insert(auditEvents).values({
      id: generatePersistedId(),
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

  /**
   * Runs one command in one transaction: a request that reuses a command id
   * replays the stored outcome when it is the same request and conflicts
   * otherwise; a new request decides, applies and records its outcome.
   */
  const run = async (
    request: CommandRequest,
  ): Promise<GenericOperatorCommandResult> => {
    const fingerprint = requestFingerprint(request);
    const outcome = await inTransaction(
      request.workspaceId,
      request.signal,
      async (
        transaction,
      ): Promise<GenericOperatorCommandResult | 'conflict'> => {
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
          await audit(transaction, request, {
            outcome: same ? existing.outcome : 'conflict',
            replayed: true,
            requestFingerprint: fingerprint,
          });
          if (!same) return 'conflict';
          return Object.freeze({
            commandId: request.commandId,
            outcome: existing.outcome,
            replayed: true,
            result: Object.freeze(resultSchema.parse(existing.result)),
            status: statusSchema.parse(existing.status),
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
        await audit(transaction, request, {
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
  };

  return Object.freeze({
    checkReadiness: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      await checkDatabaseReadiness(pool);
    },
    close: () => lease.close(),
    getCommand: async (input: GetOperatorCommandInput) => {
      const parsed = getCommandInputSchema.parse(input);
      return inTransaction(parsed.workspaceId, parsed.signal, async (tx) => {
        const [row] = await tx.db
          .select()
          .from(operatorCommands)
          .where(
            and(
              eq(operatorCommands.workspaceId, tx.workspaceId),
              eq(operatorCommands.id, parsed.commandId),
            ),
          );
        await tx.db.insert(auditEvents).values({
          id: generatePersistedId(),
          workspaceId: tx.workspaceId,
          action: 'operator.command_status',
          targetType: 'operator-command',
          targetId: parsed.commandId,
          requestId: generatePersistedId(),
          metadata: {
            actorRef: parsed.actorRef,
            found: row !== undefined,
            reason: parsed.reason,
          },
        });
        return row === undefined ? null : commandRecord(row);
      });
    },
    redispatchFailedOutbox: async (input: RedispatchFailedOutboxInput) => {
      const parsed = redispatchInputSchema.parse(input);
      const result = await run({
        ...parsed,
        commandType: 'outbox.redispatch',
        material: { outboxEventId: parsed.outboxEventId },
        target: { type: 'outbox-event', id: parsed.outboxEventId },
        decide: (transaction) => redispatchFailedOutbox(transaction, parsed),
      });
      return Object.freeze({
        commandId: result.commandId,
        outcome: result.outcome as OperatorCommandOutcome,
        replayed: result.replayed,
        status: result.status,
      });
    },
    reconcileAttempt: async (input: ReconcileOperatorAttemptInput) => {
      const parsed = reconcileAttemptInputSchema.parse(input);
      return run({
        ...parsed,
        commandType: 'attempt.reconcile',
        material: {
          action: parsed.action,
          expectedFence: parsed.expectedFenceToken,
          targetId: parsed.attemptId,
        },
        target: { type: 'operator-command-target', id: parsed.attemptId },
        decide: (transaction) => reconcileAttempt(transaction, parsed),
      });
    },
    resumeDueWork: async (input: OperatorRunCommandInput) => {
      const parsed = targetRunInputSchema.parse(input);
      return run({
        ...parsed,
        commandType: 'due-work.resume',
        material: { targetId: parsed.runId },
        target: { type: 'operator-command-target', id: parsed.runId },
        decide: (transaction) => resumeDueWork(transaction, parsed),
      });
    },
    cancelRun: async (input: OperatorRunCommandInput) => {
      const parsed = targetRunInputSchema.parse(input);
      return run({
        ...parsed,
        commandType: 'run.cancel',
        material: { targetId: parsed.runId },
        target: { type: 'operator-command-target', id: parsed.runId },
        decide: (transaction) => cancelRun(transaction, parsed),
      });
    },
    recordUnknownOutcomeEvidence: async (
      input: RecordUnknownOutcomeEvidenceInput,
    ) => {
      const parsed = unknownEvidenceInputSchema.parse(input);
      const evidenceRef = serializeBoundedPlainJson(
        parsed.evidenceRef,
        4096,
        'Unknown outcome evidence',
      );
      return run({
        ...parsed,
        dryRun: false,
        commandType: 'unknown-outcome.record-evidence',
        material: {
          evidenceKind: parsed.evidenceKind,
          evidenceRef: JSON.parse(evidenceRef) as unknown,
          targetId: parsed.attemptId,
        },
        target: { type: 'operator-command-target', id: parsed.attemptId },
        decide: (transaction) =>
          recordUnknownOutcomeEvidence(transaction, { ...parsed, evidenceRef }),
      });
    },
    retryTriggerReconciliation: async (input: OperatorWorkflowCommandInput) => {
      const parsed = targetWorkflowInputSchema.parse(input);
      return run({
        ...parsed,
        commandType: 'trigger.reconcile',
        material: { workflowId: parsed.workflowId },
        target: { type: 'workflow', id: parsed.workflowId },
        decide: (transaction) =>
          retryTriggerReconciliation(transaction, parsed),
      });
    },
    replayRun: async (input: ReplayOperatorRunInput) => {
      const parsed = replayRunInputSchema.parse(input);
      const runInput = serializeBoundedPlainJson(
        parsed.runInput,
        65_536,
        'Operator replay input',
      );
      return run({
        ...parsed,
        commandType: 'run.replay',
        material: {
          runInput: JSON.parse(runInput) as unknown,
          sourceRunId: parsed.sourceRunId,
          workflowVersionId: parsed.workflowVersionId,
        },
        target: { type: 'workflow-run', id: parsed.sourceRunId },
        auditMetadata: { workflowVersionId: parsed.workflowVersionId },
        decide: (transaction, fingerprint) =>
          requestRunReplay(transaction, {
            ...parsed,
            runInput,
            requestFingerprint: fingerprint,
          }),
      });
    },
  });
}
