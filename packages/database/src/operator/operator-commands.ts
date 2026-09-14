import { z } from 'zod';
import type {
  GenericOperatorCommandResult,
  OperatorCommandDatabaseOptions,
} from './operator-command-contracts.js';
export type {
  GenericOperatorCommandResult,
  OperatorCommandDatabaseOptions,
} from './operator-command-contracts.js';
import { sha256HexSchema } from '../validation/persisted-primitives.js';
import { serializeBoundedPlainJson } from '../execution/outbox.js';

import type { DatabaseConfig } from '../config.js';
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
    runInput: z.unknown(),
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
    evidenceRef: z.custom<Readonly<Record<string, unknown>>>(
      (value) =>
        typeof value === 'object' && value !== null && !Array.isArray(value),
    ),
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
type OperatorCommandType =
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
const persistedDateSchema = z
  .union([z.date(), z.string()])
  .pipe(z.coerce.date());
const commandRecordRowSchema = z.object({
  command_id: z.uuid(),
  command_type: commandTypeSchema,
  completed_at: persistedDateSchema.nullable(),
  created_at: persistedDateSchema,
  dry_run: z.boolean(),
  command_outcome: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
  request_fingerprint: sha256HexSchema,
  command_status: z.enum(['completed', 'failed', 'pending']),
  result: z.record(z.string(), z.unknown()),
});
const redispatchRowSchema = z.object({
  command_id: z.uuid(),
  command_outcome: z.union([outcomeSchema, z.literal('conflict')]),
  command_status: z.literal('completed'),
  replayed: z.boolean(),
});

function decodeCommandRecord(
  response: Readonly<{ rows: readonly Record<string, unknown>[] }>,
): OperatorCommandRecord | null {
  const source = response.rows[0];
  if (source === undefined) return null;
  const row = commandRecordRowSchema.parse(source);
  const priorFailedAtSource = row.result.priorFailedAt ?? null;
  const priorFailedAt = z
    .union([persistedDateSchema, z.null()])
    .parse(priorFailedAtSource);
  return Object.freeze({
    commandId: row.command_id,
    commandType: row.command_type,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    dryRun: row.dry_run,
    outcome: row.command_outcome,
    priorErrorCode: z
      .string()
      .nullable()
      .parse(row.result.priorErrorCode ?? null),
    priorFailedAt,
    priorPublishAttempts: z.coerce
      .number()
      .int()
      .nonnegative()
      .nullable()
      .parse(row.result.priorPublishAttempts ?? null),
    result: Object.freeze(row.result),
    requestFingerprint: row.request_fingerprint,
    status: row.command_status,
  });
}

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
      return runtime.transactionDecoded<
        Record<string, unknown>,
        OperatorCommandRecord | null
      >(
        `select * from app.get_operator_command(
            $1::uuid,$2::uuid,$3::varchar,$4::varchar)`,
        [parsed.commandId, parsed.workspaceId, parsed.actorRef, parsed.reason],
        decodeCommandRecord,
        parsed.signal,
      );
    },
    redispatchFailedOutbox: async (
      input: RedispatchFailedOutboxInput,
    ): Promise<OperatorCommandResult> => {
      const parsed = redispatchInputSchema.parse(input);
      const decoded = await runtime.transactionDecoded<
        Record<string, unknown>,
        Readonly<{
          conflict: boolean;
          result?: OperatorCommandResult;
        }>
      >(
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
        (response) => {
          const source = response.rows[0];
          if (source === undefined)
            throw new Error('Operator command returned no result');
          const row = redispatchRowSchema.parse(source);
          if (row.command_outcome === 'conflict') return { conflict: true };
          return Object.freeze({
            conflict: false,
            result: Object.freeze({
              commandId: row.command_id,
              outcome: row.command_outcome,
              replayed: row.replayed,
              status: row.command_status,
            }),
          });
        },
        parsed.signal,
      );
      if (decoded.conflict) throw new OperatorCommandConflictError();
      if (decoded.result === undefined)
        throw new Error('Operator command result decoder is incomplete');
      return decoded.result;
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
      const serialized = serializeBoundedPlainJson(
        parsed.evidenceRef,
        4096,
        'Unknown outcome evidence',
      );
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
      const serializedRunInput = serializeBoundedPlainJson(
        parsed.runInput,
        65_536,
        'Operator replay input',
      );
      return runtime.execute(
        'select * from app.request_operator_run_replay($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6::varchar,$7::varchar,$8::boolean)',
        [
          parsed.commandId,
          parsed.workspaceId,
          parsed.sourceRunId,
          parsed.workflowVersionId,
          serializedRunInput,
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
