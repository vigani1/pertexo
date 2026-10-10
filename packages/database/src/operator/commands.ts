import { createHash } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

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
  type OperatorDecision,
} from './command-handlers.js';

export class OperatorCommandConflictError extends Error {
  public constructor() {
    super('Operator command replay conflicts with the existing request');
    this.name = 'OperatorCommandConflictError';
  }
}

const actorRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u);
const reasonSchema = z.string().min(1).max(512);
const signalSchema = z
  .custom<AbortSignal>((value) => value instanceof AbortSignal)
  .optional();
const baseCommandInputSchema = z.object({
  actorRef: actorRefSchema,
  commandId: z.uuid(),
  dryRun: z.boolean(),
  reason: reasonSchema,
  signal: signalSchema,
  workspaceId: z.uuid(),
});
const redispatchInputSchema = baseCommandInputSchema
  .extend({ outboxEventId: z.uuid() })
  .strict();
const reconcileAttemptInputSchema = baseCommandInputSchema
  .extend({
    action: z.enum(['reclaim', 'outcome_unknown']),
    attemptId: z.uuid(),
    expectedFenceToken: z.number().int().positive(),
  })
  .strict();
const targetRunInputSchema = baseCommandInputSchema
  .extend({ runId: z.uuid() })
  .strict();
const targetWorkflowInputSchema = baseCommandInputSchema
  .extend({ workflowId: z.uuid() })
  .strict();
const replayRunInputSchema = baseCommandInputSchema
  .extend({
    runInput: z.unknown(),
    sourceRunId: z.uuid(),
    workflowVersionId: z.uuid(),
  })
  .strict();
const unknownEvidenceInputSchema = baseCommandInputSchema
  .omit({ dryRun: true })
  .extend({
    attemptId: z.uuid(),
    evidenceKind: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
    evidenceRef: z.custom<Readonly<Record<string, unknown>>>(
      (value) =>
        typeof value === 'object' && value !== null && !Array.isArray(value),
    ),
  })
  .strict();
const getCommandInputSchema = z
  .object({
    actorRef: actorRefSchema,
    commandId: z.uuid(),
    reason: reasonSchema,
    signal: signalSchema,
    workspaceId: z.uuid(),
  })
  .strict();
const optionsSchema = z.object({
  lockTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
  statementTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
});

export type OperatorCommandDatabaseOptions = Readonly<
  z.input<typeof optionsSchema>
>;
export type RedispatchFailedOutboxInput = Readonly<
  z.input<typeof redispatchInputSchema>
>;
export type ReconcileOperatorAttemptInput = Readonly<
  z.input<typeof reconcileAttemptInputSchema>
>;
export type OperatorRunCommandInput = Readonly<
  z.input<typeof targetRunInputSchema>
>;
export type OperatorWorkflowCommandInput = Readonly<
  z.input<typeof targetWorkflowInputSchema>
>;
export type ReplayOperatorRunInput = Readonly<
  z.input<typeof replayRunInputSchema>
>;
export type RecordUnknownOutcomeEvidenceInput = Readonly<
  z.input<typeof unknownEvidenceInputSchema>
>;
export type GetOperatorCommandInput = Readonly<
  z.input<typeof getCommandInputSchema>
>;

type CommandStatus = 'completed' | 'failed' | 'pending';
type OperatorCommandType =
  | 'attempt.reconcile'
  | 'due-work.resume'
  | 'outbox.redispatch'
  | 'run.cancel'
  | 'run.replay'
  | 'trigger.reconcile'
  | 'unknown-outcome.record-evidence';

export type GenericOperatorCommandResult = Readonly<{
  commandId: string;
  outcome: string;
  replayed: boolean;
  result: Readonly<Record<string, unknown>>;
  status: CommandStatus;
}>;
export type OperatorCommandOutcome =
  | 'already_published'
  | 'not_failed'
  | 'not_found'
  | 'redispatched'
  | 'would_redispatch';
export type OperatorCommandResult = Readonly<{
  commandId: string;
  outcome: OperatorCommandOutcome;
  replayed: boolean;
  status: CommandStatus;
}>;
export type OperatorCommandRecord = Readonly<{
  commandId: string;
  commandType: OperatorCommandType;
  completedAt: Date | null;
  createdAt: Date;
  dryRun: boolean;
  outcome: string;
  priorErrorCode: string | null;
  priorFailedAt: Date | null;
  priorPublishAttempts: number | null;
  result: Readonly<Record<string, unknown>>;
  requestFingerprint: string;
  status: CommandStatus;
}>;

export interface OperatorCommandDatabase {
  checkReadiness(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  getCommand(
    input: GetOperatorCommandInput,
  ): Promise<OperatorCommandRecord | null>;
  cancelRun(
    input: OperatorRunCommandInput,
  ): Promise<GenericOperatorCommandResult>;
  reconcileAttempt(
    input: ReconcileOperatorAttemptInput,
  ): Promise<GenericOperatorCommandResult>;
  recordUnknownOutcomeEvidence(
    input: RecordUnknownOutcomeEvidenceInput,
  ): Promise<GenericOperatorCommandResult>;
  redispatchFailedOutbox(
    input: RedispatchFailedOutboxInput,
  ): Promise<OperatorCommandResult>;
  resumeDueWork(
    input: OperatorRunCommandInput,
  ): Promise<GenericOperatorCommandResult>;
  replayRun(
    input: ReplayOperatorRunInput,
  ): Promise<GenericOperatorCommandResult>;
  retryTriggerReconciliation(
    input: OperatorWorkflowCommandInput,
  ): Promise<GenericOperatorCommandResult>;
}

/** Seed of the advisory lock that serializes requests reusing one command id. */
const COMMAND_LOCK_SEED = 7_166_118_813;
/** Request material is bounded by the largest field, a 64 KiB replay input. */
const MATERIAL_BYTES = 131_072;

type CommandRequest = Readonly<{
  commandId: string;
  workspaceId: string;
  commandType: OperatorCommandType;
  actorRef: string;
  reason: string;
  dryRun: boolean;
  signal?: AbortSignal | undefined;
  /** Request fields beyond the common ones; they key the command's replay. */
  material: Readonly<Record<string, unknown>>;
  target: Readonly<{ type: string; id: string }>;
  /** Request facts every audit event of this command carries. */
  auditMetadata?: Readonly<Record<string, unknown>>;
  decide: (
    transaction: WorkspaceTransaction,
    requestFingerprint: string,
  ) => Promise<OperatorDecision>;
}>;

function requestFingerprint(request: CommandRequest): string {
  const material = serializeBoundedPlainJson(
    {
      ...request.material,
      actorRef: request.actorRef,
      commandType: request.commandType,
      dryRun: request.dryRun,
      reason: request.reason,
      workspaceId: request.workspaceId,
    },
    MATERIAL_BYTES,
    'Operator command request',
  );
  return createHash('sha256').update(material).digest('hex');
}

const statusSchema = z.enum(['completed', 'failed', 'pending']);
const resultSchema = z.record(z.string(), z.unknown());

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
        const status = decision.pending === true ? 'pending' : 'completed';
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

const persistedDateSchema = z
  .union([z.date(), z.string()])
  .pipe(z.coerce.date());
const commandTypeSchema = z.enum([
  'attempt.reconcile',
  'due-work.resume',
  'outbox.redispatch',
  'run.cancel',
  'run.replay',
  'trigger.reconcile',
  'unknown-outcome.record-evidence',
]);

function commandRecord(
  row: typeof operatorCommands.$inferSelect,
): OperatorCommandRecord {
  const result = resultSchema.parse(row.result);
  return Object.freeze({
    commandId: row.id,
    commandType: commandTypeSchema.parse(row.commandType),
    completedAt:
      row.completedAt === null
        ? null
        : persistedDateSchema.parse(row.completedAt),
    createdAt: persistedDateSchema.parse(row.createdAt),
    dryRun: row.dryRun,
    outcome: row.outcome,
    priorErrorCode: z
      .string()
      .nullable()
      .parse(result.priorErrorCode ?? null),
    priorFailedAt: persistedDateSchema
      .nullable()
      .parse(result.priorFailedAt ?? null),
    priorPublishAttempts: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .parse(result.priorPublishAttempts ?? null),
    result: Object.freeze(result),
    requestFingerprint: row.requestFingerprint,
    status: statusSchema.parse(row.status),
  });
}
