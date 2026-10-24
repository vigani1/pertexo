import { z } from 'zod';

import type { WorkspaceTransaction } from '../tenant-access/transactions.js';
import type { OperatorDecision } from './command-handlers.js';

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

export const redispatchInputSchema = baseCommandInputSchema
  .extend({ outboxEventId: z.uuid() })
  .strict();

export const reconcileAttemptInputSchema = baseCommandInputSchema
  .extend({
    action: z.enum(['reclaim', 'outcome_unknown']),
    attemptId: z.uuid(),
    expectedFenceToken: z.number().int().positive(),
  })
  .strict();

export const targetRunInputSchema = baseCommandInputSchema
  .extend({ runId: z.uuid() })
  .strict();

export const targetWorkflowInputSchema = baseCommandInputSchema
  .extend({ workflowId: z.uuid() })
  .strict();

export const replayRunInputSchema = baseCommandInputSchema
  .extend({
    runInput: z.unknown(),
    sourceRunId: z.uuid(),
    workflowVersionId: z.uuid(),
  })
  .strict();

export const unknownEvidenceInputSchema = baseCommandInputSchema
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

export const getCommandInputSchema = z
  .object({
    actorRef: actorRefSchema,
    commandId: z.uuid(),
    reason: reasonSchema,
    signal: signalSchema,
    workspaceId: z.uuid(),
  })
  .strict();

export const optionsSchema = z.object({
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

export type CommandRequest = Readonly<{
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
