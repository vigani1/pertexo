import type { CodeDiagnostics } from '@pertexo/node-sdk';
import type {
  NodeExecutorErrorKind,
  NodeExecutorFailureKind,
} from '@pertexo/node-sdk/server';
import type { WorkspaceVariableValues } from '@pertexo/workflow-model';
import type { WorkflowNodeFailureValue } from '@pertexo/workflow-model';

import type { createNodeAttemptRunStore } from './node-attempt-run.store.js';

export type NodeAttemptDelivery = Readonly<{
  outboxEventId: string;
  payloadChecksum: string;
}>;

export type NodeAttemptLease = Readonly<{
  workspaceId: string;
  runId: string;
  workflowVersionId: string;
  /** Checkpoint revision observed under the run lock at claim. */
  checkpointRevision: number | null;
  nodeRunId: string;
  attemptId: string;
  attemptNumber: number;
  admissionKind: 'execute' | 'retry' | 'wait_resume';
  invocationKey: string;
  nodeId: string;
  branchPath?: readonly Readonly<{ nodeId: string; outputPort: string }>[];
  iterationPath?: readonly Readonly<{
    loopNodeId: string;
    ordinal: number;
  }>[];
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
  providerIdempotencyKey?: string;
  providerDispatchBinding?: string;
  providerDispatchUnresolved?: true;
  workerId: string;
  fenceToken: number;
  leaseExpiresAt: Date;
  delivery: NodeAttemptDelivery;
}>;

export type NodeAttemptClaimResult =
  | Readonly<{ kind: 'duplicate' }>
  | Readonly<{ kind: 'claimed'; lease: NodeAttemptLease }>;

/** Whether the run wants this attempt to stop, and why. */
export type NodeAttemptControl =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'abort'; reason: 'canceled' | 'timed_out' }>;

/** What the database holds for an attempt; execution projects the rest. */
export type NodeAttemptStoredInputs = Readonly<{
  runInput: unknown;
  variables?: WorkspaceVariableValues;
  completedNodeOutputs: readonly Readonly<{
    invocationKey: string;
    nodeId: string;
    value: unknown;
  }>[];
  sourceFailure?: WorkflowNodeFailureValue;
  resumeOutput?: unknown;
  control: NodeAttemptControl;
  deadlineAt?: Date;
  /** The run's stored checkpoint JSON. */
  checkpoint: unknown;
}>;

/** The succeeded output of the node that declared a For Each collection. */
export type NodeAttemptLoopDeclaration = Readonly<{
  nodeId: string;
  attemptId: string;
  output: unknown;
}>;

/** A succeeded attempt's stored output, such as a Merge branch's result. */
export type NodeAttemptStoredOutput = Readonly<{
  attemptId: string;
  output: unknown;
}>;

/** One settled run of a step, with the size of what it stored. */
export type NodeRunOutcome = Readonly<{
  invocationKey: string;
  status: 'succeeded' | 'skipped';
  outputBytes: number;
}>;

/** A succeeded step run's stored output, such as a For Each pass's result. */
export type NodeRunStoredOutput = Readonly<{
  invocationKey: string;
  output: unknown;
}>;

export type NodeAttemptCompletion =
  | Readonly<{ status: 'succeeded'; output: unknown }>
  | Readonly<{ status: 'suspended'; output: unknown; durationSeconds: number }>
  | Readonly<{
      status: 'failed' | 'canceled' | 'timed_out' | 'outcome_unknown';
      safeErrorCode: string;
      errorSummary?: string;
    }>
  | Readonly<{
      status: 'executor_failure';
      failureKind: NodeExecutorFailureKind;
      minimumRetryDelayMillis?: number;
      errorKind: NodeExecutorErrorKind;
      possiblyDispatched: boolean;
      safeErrorCode: string;
      errorSummary?: string;
    }>;

export type CompleteNodeAttemptResult =
  | Readonly<{ kind: 'committed'; outboxEventId: string }>
  | Readonly<{ kind: 'duplicate'; outboxEventId: null }>;

/** An attempt in one of these has settled, and a repeat of its work is a duplicate. */
export const SETTLED_ATTEMPT_STATUSES: readonly string[] = [
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
];

export type ClaimDeliveryInput = Readonly<{
  workspaceId: string;
  runId: string;
  nodeRunId: string;
  attemptId: string;
  delivery: NodeAttemptDelivery;
  leaseDurationSeconds: number;
  workerId: string;
  signal: AbortSignal;
}>;

/** Which attempt a delivery claims to be for. */
export type NodeAttemptDeliveryIdentity = Pick<
  ClaimDeliveryInput,
  'workspaceId' | 'runId' | 'nodeRunId' | 'attemptId' | 'delivery'
>;

export type NodeAttemptClaimRefusal = NodeAttemptDeliveryIdentity &
  Readonly<{
    checkpointRevision: number | null;
    fenceToken: number;
  }>;

export type LoadInputsInput = Readonly<{
  lease: NodeAttemptLease;
  sourceFailure?: Readonly<{ nodeId: string; invocationKey: string }>;
  upstreamNodeOutputs: readonly Readonly<{
    nodeId: string;
    invocationKey: string;
  }>[];
  signal: AbortSignal;
}>;

export type ReadLoopDeclarationInput = Readonly<{
  lease: NodeAttemptLease;
  controlInvocationKey: string;
  signal: AbortSignal;
}>;

export type ReadAttemptOutputsInput = Readonly<{
  lease: NodeAttemptLease;
  attemptIds: readonly string[];
  signal: AbortSignal;
}>;

/** Every settled run of one step in the leased run, without outputs. */
export type ListNodeOutcomesInput = Readonly<{
  lease: NodeAttemptLease;
  nodeId: string;
  signal: AbortSignal;
}>;

export type ReadNodeOutputsInput = Readonly<{
  lease: NodeAttemptLease;
  invocationKeys: readonly string[];
  signal: AbortSignal;
}>;

export type MarkDispatchedInput = Readonly<{
  lease: NodeAttemptLease;
  connectionFence?: Readonly<{
    connectionId: string;
    expectedProviderKey: string;
    expectedAuthType: string;
    secretVersionId: string;
  }>;
  providerDispatchBinding?: string;
  signal: AbortSignal;
}>;

export type HeartbeatInput = Readonly<{
  lease: NodeAttemptLease;
  leaseDurationSeconds: number;
  signal: AbortSignal;
}>;

export type NodeAttemptHeartbeat = Readonly<{
  leaseExpiresAt: Date;
  control: NodeAttemptControl;
}>;

export type RecordInputInput = Readonly<{
  lease: NodeAttemptLease;
  input: unknown;
  signal: AbortSignal;
}>;

export type CompleteAttemptInput = Readonly<{
  lease: NodeAttemptLease;
  outcome: NodeAttemptCompletion;
  codeDiagnostics?: CodeDiagnostics;
  connectionHealthObservation?:
    | Readonly<{ kind: 'healthy' }>
    | Readonly<{
        kind: 'reauthorization_required';
        reasonCode:
          | 'connection.slack_account_inactive'
          | 'connection.slack_token_expired'
          | 'connection.slack_token_revoked';
      }>;
  traceparent?: string;
  signal: AbortSignal;
}>;

export type NodeAttemptRunStore = ReturnType<typeof createNodeAttemptRunStore>;
