import type { z } from 'zod';

import type { WorkspaceTransaction } from '../tenant-access/transactions.js';

import type { OperatorDecision } from './handlers/contract.js';
import type {
  redispatchInputSchema,
  reconcileAttemptInputSchema,
  targetRunInputSchema,
  targetWorkflowInputSchema,
  replayRunInputSchema,
  unknownEvidenceInputSchema,
  getCommandInputSchema,
  optionsSchema,
} from './input.js';

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
