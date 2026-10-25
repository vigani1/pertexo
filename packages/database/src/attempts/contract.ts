import type { CodeDiagnostics } from '@pertexo/node-sdk';
import type { WorkspaceVariableValues } from '@pertexo/workflow-model';
import type { WorkflowNodeFailureValue } from '@pertexo/workflow-model';

export type NodeAttemptDelivery = Readonly<{
  outboxEventId: string;
  payloadChecksum: string;
}>;

export type NodeAttemptLease = Readonly<{
  workspaceId: string;
  runId: string;
  workflowVersionId: string;
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
  abortRequested: boolean;
  abortReason?: 'canceled' | 'timed_out';
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
      failureKind: 'failed' | 'canceled' | 'retry' | 'outcome_unknown';
      minimumRetryDelayMillis?: number;
      errorKind:
        | 'authentication'
        | 'canceled'
        | 'configuration'
        | 'internal'
        | 'network'
        | 'provider'
        | 'rate_limit'
        | 'timeout';
      possiblyDispatched: boolean;
      safeErrorCode: string;
      errorSummary?: string;
    }>;

export type CompleteNodeAttemptResult =
  | Readonly<{ kind: 'committed'; outboxEventId: string }>
  | Readonly<{ kind: 'duplicate'; outboxEventId: null }>;

export interface NodeAttemptRunStore {
  claimDelivery(
    input: Readonly<{
      workspaceId: string;
      runId: string;
      nodeRunId: string;
      attemptId: string;
      delivery: NodeAttemptDelivery;
      leaseDurationSeconds: number;
      workerId: string;
      signal: AbortSignal;
    }>,
  ): Promise<NodeAttemptClaimResult>;
  loadInputs(
    input: Readonly<{
      lease: NodeAttemptLease;
      sourceFailure?: Readonly<{ nodeId: string; invocationKey: string }>;
      upstreamNodeOutputs: readonly Readonly<{
        nodeId: string;
        invocationKey: string;
      }>[];
      signal: AbortSignal;
    }>,
  ): Promise<NodeAttemptStoredInputs>;
  readLoopDeclaration(
    input: Readonly<{
      lease: NodeAttemptLease;
      controlInvocationKey: string;
      signal: AbortSignal;
    }>,
  ): Promise<NodeAttemptLoopDeclaration | undefined>;
  readAttemptOutputs(
    input: Readonly<{
      lease: NodeAttemptLease;
      attemptIds: readonly string[];
      signal: AbortSignal;
    }>,
  ): Promise<readonly NodeAttemptStoredOutput[]>;
  /** Every settled run of one step in the leased run, without outputs. */
  listNodeOutcomes(
    input: Readonly<{
      lease: NodeAttemptLease;
      nodeId: string;
      signal: AbortSignal;
    }>,
  ): Promise<readonly NodeRunOutcome[]>;
  readNodeOutputs(
    input: Readonly<{
      lease: NodeAttemptLease;
      invocationKeys: readonly string[];
      signal: AbortSignal;
    }>,
  ): Promise<readonly NodeRunStoredOutput[]>;
  markDispatched(
    input: Readonly<{
      lease: NodeAttemptLease;
      connectionFence?: Readonly<{
        connectionId: string;
        expectedProviderKey: string;
        expectedAuthType: string;
        secretVersionId: string;
      }>;
      providerDispatchBinding?: string;
      signal: AbortSignal;
    }>,
  ): Promise<Readonly<{ dispatchedAt: Date }>>;
  heartbeat(
    input: Readonly<{
      lease: NodeAttemptLease;
      leaseDurationSeconds: number;
      signal: AbortSignal;
    }>,
  ): Promise<
    Readonly<{
      leaseExpiresAt: Date;
      abortRequested: boolean;
      abortReason?: 'canceled' | 'timed_out';
    }>
  >;
  /**
   * Records the input the attempt's executor is about to receive (ADR 052).
   * Diagnostic: it records nothing, and never throws, when the lease is gone
   * or the input is over the inline bound. A store may leave it out.
   */
  recordInput?(
    input: Readonly<{
      lease: NodeAttemptLease;
      input: unknown;
      signal: AbortSignal;
    }>,
  ): Promise<Readonly<{ recorded: boolean }>>;
  complete(
    input: Readonly<{
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
    }>,
  ): Promise<CompleteNodeAttemptResult>;
  close(): Promise<void>;
}
