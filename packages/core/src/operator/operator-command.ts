import type {
  AuditMetadata,
  WorkspaceTransaction,
} from '@pertexo/database/primitives';
import type { OperatorDecision } from './handlers/decision.js';

export class OperatorCommandConflictError extends Error {
  public constructor() {
    super('Operator command replay conflicts with the existing request');
    this.name = 'OperatorCommandConflictError';
  }
}

export type OperatorCommandStoreOptions = Readonly<{
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}>;

type CommandInput = Readonly<{
  actorRef: string;
  commandId: string;
  dryRun: boolean;
  reason: string;
  workspaceId: string;
  signal?: AbortSignal | undefined;
}>;

export type RedispatchFailedOutboxInput = CommandInput &
  Readonly<{ outboxEventId: string }>;

export type ReconcileOperatorAttemptInput = CommandInput &
  Readonly<{
    action: 'outcome_unknown' | 'reclaim';
    attemptId: string;
    expectedFenceToken: number;
  }>;

export type OperatorRunCommandInput = CommandInput &
  Readonly<{ runId: string }>;

export type OperatorWorkflowCommandInput = CommandInput &
  Readonly<{ workflowId: string }>;

export type ReplayOperatorRunInput = CommandInput &
  Readonly<{
    runInput: unknown;
    sourceRunId: string;
    workflowVersionId: string;
  }>;

export type RecordUnknownOutcomeEvidenceInput = Omit<CommandInput, 'dryRun'> &
  Readonly<{
    attemptId: string;
    evidenceKind: string;
    evidenceRef: Readonly<Record<string, unknown>>;
  }>;

export type GetOperatorCommandInput = Omit<CommandInput, 'dryRun'>;

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
