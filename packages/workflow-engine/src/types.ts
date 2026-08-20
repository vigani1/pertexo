export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const NODE_STATUSES = [
  'pending',
  'ready',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'canceled',
  'timed_out',
  'outcome_unknown',
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const ATTEMPT_STATUSES = [
  'pending',
  'ready',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export type SideEffectClass = 'safe' | 'idempotent_with_key' | 'unsafe';
export type BranchDisposition =
  'pending' | 'arrived' | 'skipped' | 'missing' | 'failed' | 'canceled';

export type OutputReference =
  | Readonly<{ readonly kind: 'inline'; readonly attemptId: string }>
  | Readonly<{ readonly kind: 'artifact'; readonly artifactId: string }>;

export interface InvocationState {
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly status: NodeStatus;
  readonly attemptNumber: number;
  readonly resumeAt?: string;
  readonly output?: OutputReference;
}

export interface BranchLedgerEntry {
  readonly branchId: string;
  readonly disposition: BranchDisposition;
  readonly output?: OutputReference;
}

export type JoinPolicy =
  | { readonly kind: 'all' }
  | { readonly kind: 'any' }
  | { readonly kind: 'count'; readonly count: number };

export interface JoinState {
  readonly joinId: string;
  readonly policy: JoinPolicy;
  readonly ledger: readonly BranchLedgerEntry[];
  readonly selectedBranchIds?: readonly string[];
  readonly unsatisfiedReasonCode?:
    'branch_failed' | 'branch_canceled' | 'insufficient_arrivals';
}

export interface LoopState {
  readonly loopId: string;
  readonly collection: OutputReference;
  readonly collectionChecksum: string;
  readonly collectionSize: number;
  readonly maxConcurrency: number;
  readonly maxIterations: number;
  readonly nextOrdinal: number;
  readonly activeOrdinals: readonly number[];
  readonly terminalOrdinals: readonly number[];
}

export interface WorkflowCheckpointV1 {
  readonly schemaVersion: 1;
  readonly engineVersion: string;
  readonly workflowVersionId: string;
  readonly revision: number;
  readonly runStatus: RunStatus;
  readonly nextEventSequence: number;
  readonly readySet: readonly string[];
  readonly admittedInvocationKeys: readonly string[];
  readonly invocations: readonly InvocationState[];
  readonly joins: readonly JoinState[];
  readonly loops: readonly LoopState[];
  readonly remainingIterationBudget: number;
  readonly cancelRequested: boolean;
  readonly deadlineExpired: boolean;
}

export type EngineEventName =
  | 'run.started'
  | 'run.cancel_requested'
  | 'run.waiting'
  | 'run.succeeded'
  | 'run.failed'
  | 'run.canceled'
  | 'run.timed_out'
  | 'run.outcome_unknown'
  | 'node.ready'
  | 'node.waiting'
  | 'node.retry_scheduled'
  | 'node.succeeded'
  | 'node.failed'
  | 'node.skipped'
  | 'node.canceled'
  | 'node.timed_out'
  | 'node.outcome_unknown';

export interface EngineEventPlan {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly name: EngineEventName;
  readonly occurredAt: string;
  readonly invocationKey?: string;
  readonly nodeId?: string;
  readonly attemptNumber?: number;
  readonly reasonCode?: string;
}

export interface AttemptAdmissionPlan {
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly attemptNumber: number;
  readonly sideEffectClass: SideEffectClass;
  readonly providerIdempotencyKey?: string;
}

export interface NodeRunAdmissionPlan {
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly sideEffectClass: SideEffectClass;
}

export interface WorkflowTransitionPlan {
  readonly expectedRevision: number;
  readonly expectedNextEventSequence: number;
  readonly consumedThroughEventSequence: number;
  readonly checkpoint: WorkflowCheckpointV1;
  readonly events: readonly EngineEventPlan[];
  readonly nodeRunAdmissions: readonly NodeRunAdmissionPlan[];
  readonly attempts: readonly AttemptAdmissionPlan[];
}
