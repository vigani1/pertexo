import { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import { OperatorCommandConflictError } from './operator-command-errors.js';
import { createOperatorCommandRuntime } from './operator-command-runtime.js';

export { OperatorCommandConflictError } from './operator-command-errors.js';

const actorRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u);
const reasonSchema = z.string().min(1).max(512);
const redispatchInputSchema = z
  .object({
    actorRef: actorRefSchema,
    commandId: z.uuid(),
    dryRun: z.boolean(),
    outboxEventId: z.uuid(),
    reason: reasonSchema,
    signal: z
      .custom<AbortSignal>((value) => value instanceof AbortSignal)
      .optional(),
    workspaceId: z.uuid(),
  })
  .strict();
const baseCommandInputSchema = z.object({
  actorRef: actorRefSchema,
  commandId: z.uuid(),
  dryRun: z.boolean(),
  reason: reasonSchema,
  signal: z
    .custom<AbortSignal>((value) => value instanceof AbortSignal)
    .optional(),
  workspaceId: z.uuid(),
});
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
    runInput: z
      .json()
      .refine(
        (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 65_536,
      ),
    sourceRunId: z.uuid(),
    workflowVersionId: z.uuid(),
  })
  .strict();
const maintenanceRerunInputSchema = baseCommandInputSchema
  .extend({
    targetId: z.uuid(),
    targetType: z.enum(['retention_batch', 'workspace_purge_job']),
  })
  .strict();
const unknownEvidenceInputSchema = baseCommandInputSchema
  .omit({ dryRun: true })
  .extend({
    attemptId: z.uuid(),
    evidenceKind: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
    evidenceRef: z.record(z.string(), z.unknown()),
  })
  .strict();

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
export type OperatorMaintenanceRerunInput = Readonly<
  z.input<typeof maintenanceRerunInputSchema>
>;
export type RecordUnknownOutcomeEvidenceInput = Readonly<
  z.input<typeof unknownEvidenceInputSchema>
>;
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
  status: 'completed' | 'failed' | 'pending';
}>;
export type GenericOperatorCommandResult = Readonly<{
  commandId: string;
  outcome: string;
  replayed: boolean;
  result: Readonly<Record<string, unknown>>;
  status: 'completed' | 'failed' | 'pending';
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
  status: 'completed' | 'failed' | 'pending';
}>;
export type OperatorCommandType =
  | 'attempt.reconcile'
  | 'due-work.resume'
  | 'outbox.redispatch'
  | 'purge.rerun'
  | 'retention.rerun'
  | 'run.cancel'
  | 'run.replay'
  | 'trigger.reconcile'
  | 'unknown-outcome.record-evidence';
export type GetOperatorCommandInput = Readonly<{
  actorRef: string;
  commandId: string;
  reason: string;
  signal?: AbortSignal;
  workspaceId: string;
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
  requestMaintenanceRerun(
    input: OperatorMaintenanceRerunInput,
  ): Promise<GenericOperatorCommandResult>;
  retryTriggerReconciliation(
    input: OperatorWorkflowCommandInput,
  ): Promise<GenericOperatorCommandResult>;
}

export interface OperatorCommandDatabaseOptions {
  readonly forbiddenRoles?: readonly string[];
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

const outcomeSchema = z.enum([
  'already_published',
  'not_failed',
  'not_found',
  'redispatched',
  'would_redispatch',
]);
const commandTypeSchema = z.enum([
  'attempt.reconcile',
  'due-work.resume',
  'outbox.redispatch',
  'purge.rerun',
  'retention.rerun',
  'run.cancel',
  'run.replay',
  'trigger.reconcile',
  'unknown-outcome.record-evidence',
]);

export function createOperatorCommandDatabase(
  config: DatabaseConfig,
  operatorRole = 'pertexo_operator',
  inputOptions: OperatorCommandDatabaseOptions = {},
): OperatorCommandDatabase {
  const runtime = createOperatorCommandRuntime(
    config,
    operatorRole,
    inputOptions,
  );

  return Object.freeze({
    checkReadiness: (signal?: AbortSignal) => runtime.checkReadiness(signal),
    close: () => runtime.close(),
    cancelRun: async (input: OperatorRunCommandInput) => {
      const parsed = targetRunInputSchema.parse(input);
      return runtime.execute(
        'select * from app.cancel_operator_run($1::uuid,$2::uuid,$3::uuid,$4::varchar,$5::varchar,$6::boolean)',
        [
          parsed.commandId,
          parsed.workspaceId,
          parsed.runId,
          parsed.actorRef,
          parsed.reason,
          parsed.dryRun,
        ],
        parsed.signal,
      );
    },
    getCommand: async (
      input: GetOperatorCommandInput,
    ): Promise<OperatorCommandRecord | null> => {
      const parsed = z
        .object({
          actorRef: actorRefSchema,
          commandId: z.uuid(),
          reason: reasonSchema,
          signal: z
            .custom<AbortSignal>((value) => value instanceof AbortSignal)
            .optional(),
          workspaceId: z.uuid(),
        })
        .strict()
        .parse(input);
      const result = await runtime.transaction(
        `select * from app.get_operator_command(
            $1::uuid,$2::uuid,$3::varchar,$4::varchar)`,
        [parsed.commandId, parsed.workspaceId, parsed.actorRef, parsed.reason],
        parsed.signal,
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const commandResult = z.record(z.string(), z.unknown()).parse(row.result);
      return Object.freeze({
        commandId: z.uuid().parse(row.command_id),
        commandType: commandTypeSchema.parse(row.command_type),
        completedAt:
          row.completed_at === null
            ? null
            : new Date(z.union([z.string(), z.date()]).parse(row.completed_at)),
        createdAt: new Date(
          z.union([z.string(), z.date()]).parse(row.created_at),
        ),
        dryRun: z.boolean().parse(row.dry_run),
        outcome: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,31}$/u)
          .parse(row.command_outcome),
        priorErrorCode: z
          .string()
          .nullable()
          .parse(commandResult.priorErrorCode ?? null),
        priorFailedAt:
          commandResult.priorFailedAt == null
            ? null
            : new Date(
                z
                  .union([z.string(), z.date()])
                  .parse(commandResult.priorFailedAt),
              ),
        priorPublishAttempts: z.coerce
          .number()
          .int()
          .nonnegative()
          .nullable()
          .parse(commandResult.priorPublishAttempts ?? null),
        result: Object.freeze(commandResult),
        requestFingerprint: z
          .string()
          .regex(/^[0-9a-f]{64}$/u)
          .parse(row.request_fingerprint),
        status: z
          .enum(['completed', 'failed', 'pending'])
          .parse(row.command_status),
      });
    },
    redispatchFailedOutbox: async (
      input: RedispatchFailedOutboxInput,
    ): Promise<OperatorCommandResult> => {
      const parsed = redispatchInputSchema.parse(input);
      const result = await runtime.transaction(
        `select * from app.redispatch_failed_outbox_event(
            $1::uuid,$2::uuid,$3::uuid,$4::varchar,$5::varchar,$6::boolean)`,
        [
          parsed.commandId,
          parsed.workspaceId,
          parsed.outboxEventId,
          parsed.actorRef,
          parsed.reason,
          parsed.dryRun,
        ],
        parsed.signal,
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new Error('Operator command returned no result');
      if (row.command_outcome === 'conflict')
        throw new OperatorCommandConflictError();
      return Object.freeze({
        commandId: z.uuid().parse(row.command_id),
        outcome: outcomeSchema.parse(row.command_outcome),
        replayed: z.boolean().parse(row.replayed),
        status: z.literal('completed').parse(row.command_status),
      });
    },
    reconcileAttempt: async (input: ReconcileOperatorAttemptInput) => {
      const parsed = reconcileAttemptInputSchema.parse(input);
      return runtime.execute(
        `select * from app.reconcile_operator_attempt(
          $1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::varchar,$6::varchar,$7::varchar,$8::boolean)`,
        [
          parsed.commandId,
          parsed.workspaceId,
          parsed.attemptId,
          parsed.expectedFenceToken,
          parsed.action,
          parsed.actorRef,
          parsed.reason,
          parsed.dryRun,
        ],
        parsed.signal,
      );
    },
    recordUnknownOutcomeEvidence: async (
      input: RecordUnknownOutcomeEvidenceInput,
    ) => {
      const parsed = unknownEvidenceInputSchema.parse(input);
      const serialized = JSON.stringify(parsed.evidenceRef);
      if (Buffer.byteLength(serialized, 'utf8') > 4096)
        throw new TypeError('Unknown outcome evidence exceeds 4096 bytes');
      return runtime.execute(
        `select * from app.record_operator_unknown_outcome_evidence(
          $1::uuid,$2::uuid,$3::uuid,$4::varchar,$5::jsonb,$6::varchar,$7::varchar)`,
        [
          parsed.commandId,
          parsed.workspaceId,
          parsed.attemptId,
          parsed.evidenceKind,
          serialized,
          parsed.actorRef,
          parsed.reason,
        ],
        parsed.signal,
      );
    },
    resumeDueWork: async (input: OperatorRunCommandInput) => {
      const parsed = targetRunInputSchema.parse(input);
      return runtime.execute(
        'select * from app.resume_operator_due_work($1::uuid,$2::uuid,$3::uuid,$4::varchar,$5::varchar,$6::boolean)',
        [
          parsed.commandId,
          parsed.workspaceId,
          parsed.runId,
          parsed.actorRef,
          parsed.reason,
          parsed.dryRun,
        ],
        parsed.signal,
      );
    },
    replayRun: async (input: ReplayOperatorRunInput) => {
      const parsed = replayRunInputSchema.parse(input);
      return runtime.execute(
        'select * from app.request_operator_run_replay($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6::varchar,$7::varchar,$8::boolean)',
        [
          parsed.commandId,
          parsed.workspaceId,
          parsed.sourceRunId,
          parsed.workflowVersionId,
          JSON.stringify(parsed.runInput),
          parsed.actorRef,
          parsed.reason,
          parsed.dryRun,
        ],
        parsed.signal,
      );
    },
    requestMaintenanceRerun: async (input: OperatorMaintenanceRerunInput) => {
      const parsed = maintenanceRerunInputSchema.parse(input);
      return runtime.execute(
        'select * from app.request_operator_maintenance_rerun($1::uuid,$2::uuid,$3::varchar,$4::uuid,$5::varchar,$6::varchar,$7::boolean)',
        [
          parsed.commandId,
          parsed.workspaceId,
          parsed.targetType,
          parsed.targetId,
          parsed.actorRef,
          parsed.reason,
          parsed.dryRun,
        ],
        parsed.signal,
      );
    },
    retryTriggerReconciliation: async (input: OperatorWorkflowCommandInput) => {
      const parsed = targetWorkflowInputSchema.parse(input);
      return runtime.execute(
        'select * from app.retry_operator_trigger_reconciliation($1::uuid,$2::uuid,$3::uuid,$4::varchar,$5::varchar,$6::boolean)',
        [
          parsed.commandId,
          parsed.workspaceId,
          parsed.workflowId,
          parsed.actorRef,
          parsed.reason,
          parsed.dryRun,
        ],
        parsed.signal,
      );
    },
  });
}
