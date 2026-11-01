import type {
  AuditMetadata,
  WorkspaceTransaction,
} from '@pertexo/database/primitives';
import type { StuckWork } from '../runs/stalled/contract.js';
import type { OperatorDecision } from './handlers/contract.js';
import type {
  RedispatchInput,
  ReconcileAttemptInput,
  TargetRunInput,
  TargetWorkflowInput,
  ReplayRunInput,
  UnknownEvidenceInput,
  GetCommandInput,
  Options,
} from './input.js';

export type OperatorCommandDatabaseOptions = Readonly<Options>;

export type RedispatchFailedOutboxInput = Readonly<RedispatchInput>;

export type ReconcileOperatorAttemptInput = Readonly<ReconcileAttemptInput>;

export type OperatorRunCommandInput = Readonly<TargetRunInput>;

export type OperatorWorkflowCommandInput = Readonly<TargetWorkflowInput>;

export type ReplayOperatorRunInput = Readonly<ReplayRunInput>;

export type RecordUnknownOutcomeEvidenceInput = Readonly<UnknownEvidenceInput>;

export type GetOperatorCommandInput = Readonly<GetCommandInput>;

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

// Read projection combines stored columns with computed or joined fields.
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
  /** Reads across workspaces: an operator doesn't yet know which one is stuck. */
  listStuckWork(): Promise<StuckWork>;
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
  auditMetadata?: AuditMetadata;
  decide: (
    transaction: WorkspaceTransaction,
    requestFingerprint: string,
  ) => Promise<OperatorDecision>;
}>;
